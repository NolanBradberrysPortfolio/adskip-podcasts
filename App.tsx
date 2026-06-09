import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Clock, ListMusic, Plus, Radio, RefreshCw, Search, Trash2, Upload, X } from 'lucide-react-native';
import { analyzeEpisode, fetchApiHealth, fetchPodcastFeed, importOpml } from './src/services/api';
import { loadSavedFeeds, loadSavedSegments, saveFeeds, saveSegments } from './src/storage/subscriptions';
import type { AdSegment, PodcastEpisode, PodcastFeed } from './src/types';
import { formatDate, formatDuration } from './src/utils/format';
import { IconButton } from './src/components/IconButton';
import { PodcastPlayer } from './src/components/PodcastPlayer';

type ApiStatus = 'checking' | 'api-offline' | 'ai-offline' | 'ready';
type FocusableRef = { focus: () => void };

const WIDE_BREAKPOINT = 1120;
const DESKTOP_EPISODE_PAGE_SIZE = 80;
const MOBILE_EPISODE_PAGE_SIZE = 25;

function useModalFocusTrap(visible: boolean, modalTestId: string, initialFocusRef?: RefObject<FocusableRef | null>, restoreFocusSelector?: string) {
  useEffect(() => {
    if (!visible || Platform.OS !== 'web' || typeof document === 'undefined') {
      return undefined;
    }

    const restoreFocusTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const getFocusableElements = () => {
      const root = document.querySelector(`[data-testid="${modalTestId}"]`);
      if (!root) {
        return [] as HTMLElement[];
      }

      return Array.from(
        root.querySelectorAll<HTMLElement>(
          'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"]), [role="button"]',
        ),
      ).filter((element) => {
        const style = window.getComputedStyle(element);
        return (
          !element.hasAttribute('disabled') &&
          element.getAttribute('aria-disabled') !== 'true' &&
          style.display !== 'none' &&
          style.visibility !== 'hidden'
        );
      });
    };

    const focusTimer = window.setTimeout(() => {
      initialFocusRef?.current?.focus();
      const focusableElements = getFocusableElements();
      const root = document.querySelector(`[data-testid="${modalTestId}"]`);
      if (focusableElements[0] && root && !root.contains(document.activeElement)) {
        focusableElements[0].focus();
      }
    }, 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') {
        return;
      }

      const focusableElements = getFocusableElements();
      if (!focusableElements.length) {
        return;
      }

      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;
      const root = document.querySelector(`[data-testid="${modalTestId}"]`);

      if (root && !root.contains(activeElement)) {
        event.preventDefault();
        first.focus();
        return;
      }

      if (event.shiftKey && activeElement === first) {
        event.preventDefault();
        last.focus();
        return;
      }

      if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);

    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown, true);
      window.setTimeout(() => {
        const fallbackTarget = restoreFocusSelector ? document.querySelector<HTMLElement>(restoreFocusSelector) : null;
        const target = restoreFocusTarget && document.contains(restoreFocusTarget) ? restoreFocusTarget : fallbackTarget;
        target?.focus();
      }, 0);
    };
  }, [initialFocusRef, modalTestId, restoreFocusSelector, visible]);
}

function modalWebProps(label: string, describedBy?: string): Record<string, unknown> {
  if (Platform.OS !== 'web') {
    return {};
  }

  return {
    'aria-label': label,
    'aria-modal': true,
    ...(describedBy ? { 'aria-describedby': describedBy } : {}),
    role: 'dialog',
  } as Record<string, unknown>;
}

function liveRegionWebProps(): Record<string, unknown> {
  if (Platform.OS !== 'web') {
    return {};
  }

  return {
    'aria-atomic': 'true',
    'aria-live': 'polite',
    role: 'status',
  } as Record<string, unknown>;
}

function describedByTargetWebProps(id: string): Record<string, unknown> {
  if (Platform.OS !== 'web') {
    return {};
  }

  return { id } as Record<string, unknown>;
}

function appContentWebProps(hidden: boolean): Record<string, unknown> {
  if (Platform.OS !== 'web' || !hidden) {
    return {};
  }

  return {
    'aria-hidden': true,
  } as Record<string, unknown>;
}

export default function App() {
  const { width, height } = useWindowDimensions();
  const isWide = width >= WIDE_BREAKPOINT;
  const opmlInputRef = useRef<TextInput>(null);
  const [feedUrl, setFeedUrl] = useState('');
  const [feeds, setFeeds] = useState<PodcastFeed[]>([]);
  const [selectedFeedId, setSelectedFeedId] = useState<string>();
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<string>();
  const [segmentsByEpisode, setSegmentsByEpisode] = useState<Record<string, AdSegment[]>>({});
  const [loadingFeed, setLoadingFeed] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [message, setMessage] = useState('Ready');
  const [opmlModalOpen, setOpmlModalOpen] = useState(false);
  const [opmlText, setOpmlText] = useState('');
  const [analysisConsentOpen, setAnalysisConsentOpen] = useState(false);
  const [analysisConsentGranted, setAnalysisConsentGranted] = useState(false);
  const [apiStatus, setApiStatus] = useState<ApiStatus>('checking');
  const [episodeQuery, setEpisodeQuery] = useState('');
  const [episodeOffset, setEpisodeOffset] = useState(0);
  const [pendingDeleteFeed, setPendingDeleteFeed] = useState<PodcastFeed>();
  const modalOpen = opmlModalOpen || analysisConsentOpen || Boolean(pendingDeleteFeed);

  useEffect(() => {
    let active = true;

    Promise.all([loadSavedFeeds(), loadSavedSegments()])
      .then(([savedFeeds, savedSegments]) => {
        if (!active) {
          return;
        }

        setFeeds(savedFeeds);
        const realSegments: Record<string, AdSegment[]> = Object.fromEntries(
          Object.entries(savedSegments)
            .map(([episodeId, segments]) => [episodeId, segments.filter((segment) => segment.source !== 'demo-rule-engine')] as const)
            .filter(([, segments]) => segments.length > 0),
        );

        setSegmentsByEpisode(realSegments);
        if (JSON.stringify(realSegments) !== JSON.stringify(savedSegments)) {
          saveSegments(realSegments).catch(() => undefined);
        }
        setSelectedFeedId(savedFeeds[0]?.id);
        setSelectedEpisodeId(savedFeeds[0]?.episodes[0]?.id);
      })
      .catch(() => setMessage('Local storage unavailable'));

    return () => {
      active = false;
    };
  }, []);

  useModalFocusTrap(opmlModalOpen, 'opml-modal', opmlInputRef, '[aria-label="OPML"]');
  useModalFocusTrap(analysisConsentOpen, 'analysis-modal');
  useModalFocusTrap(Boolean(pendingDeleteFeed), 'remove-feed-modal');

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') {
      return undefined;
    }

    const appContent = document.querySelector('[data-testid="app-content"]') as (HTMLElement & { inert?: boolean }) | null;
    if (!appContent) {
      return undefined;
    }

    if (modalOpen) {
      if (document.activeElement instanceof HTMLElement && appContent.contains(document.activeElement)) {
        document.activeElement.blur();
      }
      appContent.setAttribute('aria-hidden', 'true');
      appContent.setAttribute('inert', '');
      appContent.inert = true;
    } else {
      appContent.removeAttribute('aria-hidden');
      appContent.removeAttribute('inert');
      appContent.inert = false;
    }

    return () => {
      appContent.removeAttribute('aria-hidden');
      appContent.removeAttribute('inert');
      appContent.inert = false;
    };
  }, [modalOpen]);

  const checkApiHealth = async () => {
    setApiStatus('checking');

    try {
      const health = await fetchApiHealth();
      setApiStatus(health.openai ? 'ready' : 'ai-offline');
    } catch (error) {
      setApiStatus('api-offline');
      setMessage(error instanceof Error ? error.message : 'API unavailable');
    }
  };

  useEffect(() => {
    fetchApiHealth()
      .then((health) => {
        setApiStatus(health.openai ? 'ready' : 'ai-offline');
      })
      .catch((error) => {
        setApiStatus('api-offline');
        setMessage(error instanceof Error ? error.message : 'API unavailable');
      });
  }, []);

  const selectedFeed = useMemo(
    () => feeds.find((feed) => feed.id === selectedFeedId) || feeds[0],
    [feeds, selectedFeedId],
  );

  const selectedEpisode = useMemo(() => {
    const feedEpisode = selectedFeed?.episodes.find((episode) => episode.id === selectedEpisodeId);
    if (feedEpisode) {
      return feedEpisode;
    }

    return selectedFeed?.episodes[0];
  }, [selectedEpisodeId, selectedFeed]);

  const selectedSegments = selectedEpisode ? segmentsByEpisode[selectedEpisode.id] || [] : [];
  const filteredEpisodes = useMemo(() => {
    const episodes = selectedFeed?.episodes || [];
    const query = episodeQuery.trim().toLowerCase();
    if (!query) {
      return episodes;
    }

    return episodes.filter((episode) => episode.title.toLowerCase().includes(query));
  }, [episodeQuery, selectedFeed?.episodes]);
  const episodePageSize = isWide ? DESKTOP_EPISODE_PAGE_SIZE : MOBILE_EPISODE_PAGE_SIZE;
  const maxEpisodeOffset = Math.max(filteredEpisodes.length - episodePageSize, 0);
  const boundedEpisodeOffset = Math.min(episodeOffset, maxEpisodeOffset);
  const visibleEpisodes = filteredEpisodes.slice(boundedEpisodeOffset, boundedEpisodeOffset + episodePageSize);
  const apiReachable = apiStatus === 'ready' || apiStatus === 'ai-offline';
  const serverControlsDisabled = loadingFeed || !apiReachable;
  const canAnalyze = apiStatus === 'ready';
  const nextEpisodeCount = Math.min(episodePageSize, Math.max(filteredEpisodes.length - boundedEpisodeOffset - episodePageSize, 0));
  const previousEpisodeCount = Math.min(episodePageSize, boundedEpisodeOffset);
  const canShowNextEpisodes = nextEpisodeCount > 0;
  const canShowPreviousEpisodes = boundedEpisodeOffset > 0;
  const firstVisibleEpisodeNumber = filteredEpisodes.length ? boundedEpisodeOffset + 1 : 0;
  const lastVisibleEpisodeNumber = boundedEpisodeOffset + visibleEpisodes.length;
  const episodeListMaxHeight = Math.max(320, Math.min(isWide ? 620 : 520, Math.round(height * (isWide ? 0.58 : 0.52))));

  const apiLabel =
    apiStatus === 'ready'
      ? 'AI ready'
      : apiStatus === 'ai-offline'
        ? 'AI offline'
        : apiStatus === 'checking'
          ? 'Checking API'
          : 'API offline';
  const analysisUnavailableLabel =
    apiStatus === 'api-offline' ? 'API offline' : apiStatus === 'checking' ? 'Checking API' : 'AI offline';
  const apiPillStyle =
    apiStatus === 'ready'
      ? styles.apiPillReady
      : apiStatus === 'api-offline'
        ? styles.apiPillError
        : apiStatus === 'checking'
          ? styles.apiPillChecking
          : styles.apiPillOffline;

  useEffect(() => {
    setEpisodeOffset(0);
  }, [episodeQuery, selectedFeedId]);

  const persistFeeds = async (nextFeeds: PodcastFeed[]) => {
    setFeeds(nextFeeds);
    await saveFeeds(nextFeeds);
  };

  const persistSegments = async (nextSegments: Record<string, AdSegment[]>) => {
    setSegmentsByEpisode(nextSegments);
    await saveSegments(nextSegments);
  };

  const upsertFeed = async (feed: PodcastFeed) => {
    const nextFeeds = [feed, ...feeds.filter((candidate) => candidate.feedUrl !== feed.feedUrl)];
    await persistFeeds(nextFeeds);
    setSelectedFeedId(feed.id);
    setSelectedEpisodeId(feed.episodes[0]?.id);
  };

  const addFeed = async () => {
    const trimmed = feedUrl.trim();
    if (!trimmed) {
      return;
    }

    if (!apiReachable) {
      setMessage(apiStatus === 'checking' ? 'API health check is still running' : 'API unavailable');
      return;
    }

    setLoadingFeed(true);
    setMessage('Fetching feed');

    try {
      const feed = await fetchPodcastFeed(trimmed);
      await upsertFeed(feed);
      setFeedUrl('');
      setMessage(`Added ${feed.title}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Feed failed');
    } finally {
      setLoadingFeed(false);
    }
  };

  const refreshFeed = async (feed: PodcastFeed) => {
    if (!apiReachable) {
      setMessage(apiStatus === 'checking' ? 'API health check is still running' : 'API unavailable');
      return;
    }

    setLoadingFeed(true);
    setMessage('Refreshing feed');

    try {
      const refreshed = await fetchPodcastFeed(feed.feedUrl);
      const nextFeeds = feeds.map((candidate) => (candidate.feedUrl === feed.feedUrl ? refreshed : candidate));
      await persistFeeds(nextFeeds);
      setMessage(`Refreshed ${refreshed.title}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Refresh failed');
    } finally {
      setLoadingFeed(false);
    }
  };

  const removeFeed = async (feed: PodcastFeed) => {
    const nextFeeds = feeds.filter((candidate) => candidate.id !== feed.id);
    await persistFeeds(nextFeeds);
    setSelectedFeedId(nextFeeds[0]?.id);
    setSelectedEpisodeId(nextFeeds[0]?.episodes[0]?.id);
    setMessage(`Removed ${feed.title}`);
  };

  const requestRemoveFeed = (feed: PodcastFeed) => {
    setPendingDeleteFeed(feed);
  };

  const confirmRemoveFeed = async () => {
    if (!pendingDeleteFeed) {
      return;
    }

    const feed = pendingDeleteFeed;
    setPendingDeleteFeed(undefined);
    await removeFeed(feed);
  };

  const submitOpml = async () => {
    const trimmed = opmlText.trim();
    if (!trimmed) {
      return;
    }

    if (!apiReachable) {
      setMessage(apiStatus === 'checking' ? 'API health check is still running' : 'API unavailable');
      return;
    }

    setLoadingFeed(true);
    setMessage('Importing OPML');

    try {
      const { feeds: importedUrls } = await importOpml(trimmed);
      const uniqueUrls = importedUrls.filter((url) => !feeds.some((feed) => feed.feedUrl === url)).slice(0, 12);
      const outcomes = await Promise.allSettled(uniqueUrls.map((url) => fetchPodcastFeed(url)));
      const importedFeeds = outcomes
        .filter((outcome): outcome is PromiseFulfilledResult<PodcastFeed> => outcome.status === 'fulfilled')
        .map((outcome) => outcome.value);
      const failedCount = outcomes.length - importedFeeds.length;
      if (!importedFeeds.length && failedCount > 0) {
        throw new Error('No OPML feeds could be imported');
      }
      const nextFeeds = [...importedFeeds, ...feeds];
      await persistFeeds(nextFeeds);
      setSelectedFeedId(importedFeeds[0]?.id || nextFeeds[0]?.id);
      setSelectedEpisodeId(importedFeeds[0]?.episodes[0]?.id || nextFeeds[0]?.episodes[0]?.id);
      setOpmlModalOpen(false);
      setOpmlText('');
      setMessage(failedCount ? `Imported ${importedFeeds.length} feeds; ${failedCount} failed` : `Imported ${importedFeeds.length} feeds`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'OPML import failed');
    } finally {
      setLoadingFeed(false);
    }
  };

  const runAnalysis = async () => {
    if (!selectedEpisode) {
      return;
    }

    if (apiStatus === 'api-offline' || apiStatus === 'checking') {
      setMessage(apiStatus === 'checking' ? 'API health check is still running' : 'Analysis unavailable: API offline');
      return;
    }

    if (!canAnalyze) {
      setMessage('Analysis unavailable: API has no OpenAI key');
      return;
    }

    if (!analysisConsentGranted) {
      setAnalysisConsentOpen(true);
      return;
    }

    await performAnalysis();
  };

  const performAnalysis = async () => {
    if (!selectedEpisode) {
      return;
    }

    setAnalyzing(true);
    setMessage('Analyzing episode');

    try {
      const result = await analyzeEpisode(selectedEpisode);
      await persistSegments({
        ...segmentsByEpisode,
        [selectedEpisode.id]: result.segments,
      });
      setMessage(result.message);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Analysis failed');
    } finally {
      setAnalyzing(false);
    }
  };

  const confirmAnalysis = async () => {
    setAnalysisConsentGranted(true);
    setAnalysisConsentOpen(false);
    await performAnalysis();
  };

  const handleUndoSkip = () => {
    setMessage('Returned to skipped segment');
  };

  const selectEpisode = (episode: PodcastEpisode) => {
    setSelectedEpisodeId(episode.id);
  };

  const feedLabel = (feed: PodcastFeed) => `${feed.title}, ${feed.episodes.length} ${feed.episodes.length === 1 ? 'episode' : 'episodes'}`;
  const episodeLabel = (episode: PodcastEpisode) => {
    const details = [episode.title, formatDate(episode.pubDate)];
    if (episode.duration) {
      details.push(formatDuration(episode.duration));
    }

    const segmentCount = segmentsByEpisode[episode.id]?.length || 0;
    details.push(segmentCount ? `${segmentCount} skip ${segmentCount === 1 ? 'segment' : 'segments'} available` : 'no skip segments');
    return details.join(', ');
  };

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.screen}>
        <StatusBar style="dark" />
        <View {...appContentWebProps(modalOpen)} testID="app-content">
          <ScrollView contentContainerStyle={styles.scrollContent}>
          <View style={styles.header}>
            <View style={styles.brandLockup}>
              <View style={styles.logoMark}>
                <Radio size={22} color="#F8FAF7" />
              </View>
              <View>
                <Text style={styles.brand}>SkipCast</Text>
                <Text {...liveRegionWebProps()} style={styles.statusText}>{message}</Text>
              </View>
            </View>
            <View style={[styles.headerActions, !isWide && styles.headerActionsCompact]}>
              {loadingFeed && <ActivityIndicator color="#2A9D8F" />}
              <View style={[styles.apiPill, apiPillStyle]}>
                {apiStatus === 'checking' ? (
                  <ActivityIndicator color="#5F6B63" />
                ) : apiStatus === 'ready' ? (
                  <CheckCircle2 size={16} color="#0F766E" />
                ) : (
                  <AlertTriangle size={16} color={apiStatus === 'api-offline' ? '#991B1B' : '#92400E'} />
                )}
                <Text style={styles.apiPillText}>{apiLabel}</Text>
              </View>
              {apiStatus === 'api-offline' && <IconButton icon={RefreshCw} label="Retry API" onPress={checkApiHealth} variant="secondary" />}
              <IconButton icon={Upload} label="OPML" onPress={() => setOpmlModalOpen(true)} disabled={serverControlsDisabled} variant="secondary" />
            </View>
          </View>

          <View style={styles.feedBar}>
            <TextInput
              value={feedUrl}
              onChangeText={setFeedUrl}
              accessibilityLabel="Podcast RSS feed URL"
              autoCapitalize="none"
              autoCorrect={false}
              inputMode="url"
              placeholder="https://example.com/feed.xml"
              placeholderTextColor="#5F6B63"
              onSubmitEditing={addFeed}
              style={styles.feedInput}
            />
            <IconButton icon={Plus} label="Add feed" onPress={addFeed} disabled={serverControlsDisabled || !feedUrl.trim()} variant="primary" />
          </View>

          <View style={[styles.workspace, isWide && styles.workspaceWide]}>
            <View style={[styles.panel, isWide && styles.libraryPanel]}>
              <View style={styles.panelHeader}>
                <Text style={styles.panelTitle}>Library</Text>
                <Text style={styles.countPill}>{feeds.length}</Text>
              </View>
              {feeds.length === 0 ? (
                <View style={styles.emptyPanel}>
                  <ListMusic size={26} color="#6B7280" />
                  <Text style={styles.emptyText}>No subscriptions</Text>
                </View>
              ) : (
                feeds.map((feed) => (
                  <Pressable
                    key={feed.id}
                    accessibilityRole="button"
                    accessibilityLabel={feedLabel(feed)}
                    accessibilityState={{ selected: selectedFeed?.id === feed.id }}
                    onPress={() => {
                      setSelectedFeedId(feed.id);
                      setSelectedEpisodeId(feed.episodes[0]?.id);
                    }}
                    style={[styles.feedRow, selectedFeed?.id === feed.id && styles.feedRowActive]}
                  >
                    {feed.artworkUrl ? (
                      <Image source={{ uri: feed.artworkUrl }} style={styles.feedThumb} />
                    ) : (
                      <View style={styles.feedThumbFallback}>
                        <Text style={styles.feedThumbLetter}>{feed.title.slice(0, 1).toUpperCase()}</Text>
                      </View>
                    )}
                    <View style={styles.feedCopy}>
                      <Text numberOfLines={2} style={styles.feedTitle}>
                        {feed.title}
                      </Text>
                      <Text style={styles.feedMeta}>{feed.episodes.length} episodes</Text>
                    </View>
                  </Pressable>
                ))
              )}
            </View>

            <View style={[styles.panel, isWide && styles.episodesPanel]}>
            <View style={styles.panelHeader}>
              <Text style={styles.panelTitle}>Episodes</Text>
              {selectedFeed && (
                <View style={styles.panelButtons}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Refresh feed"
                    accessibilityState={{ disabled: serverControlsDisabled }}
                    disabled={serverControlsDisabled}
                    hitSlop={6}
                    onPress={() => refreshFeed(selectedFeed)}
                    style={({ pressed }) => [
                      styles.iconOnlyButton,
                      serverControlsDisabled && styles.iconOnlyButtonDisabled,
                      pressed && !serverControlsDisabled && styles.iconOnlyButtonPressed,
                    ]}
                  >
                    <RefreshCw size={18} color={serverControlsDisabled ? '#6B7280' : '#122620'} />
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Remove feed"
                    hitSlop={6}
                    onPress={() => requestRemoveFeed(selectedFeed)}
                    style={styles.iconOnlyButton}
                  >
                    <Trash2 size={18} color="#7F1D1D" />
                  </Pressable>
                </View>
              )}
            </View>
            {selectedFeed && (
              <>
                <View style={styles.searchBar}>
                  <Search size={17} color="#5F6B63" />
                  <TextInput
                    value={episodeQuery}
                    onChangeText={setEpisodeQuery}
                    accessibilityLabel="Search episodes"
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder="Search episodes"
                    placeholderTextColor="#5F6B63"
                    style={styles.searchInput}
                  />
                </View>
                <Text {...liveRegionWebProps()} style={styles.resultText}>
                  Showing {firstVisibleEpisodeNumber}-{lastVisibleEpisodeNumber} of {filteredEpisodes.length} episodes
                </Text>
              </>
            )}
            {!selectedFeed ? (
              <View style={styles.emptyPanel}>
                <Clock size={26} color="#6B7280" />
                <Text style={styles.emptyText}>No feed selected</Text>
              </View>
            ) : (
              <>
                {visibleEpisodes.length > 0 &&
                  (isWide ? (
                    <ScrollView
                      contentContainerStyle={styles.episodeListContent}
                      nestedScrollEnabled
                      style={[styles.episodeList, { maxHeight: episodeListMaxHeight }]}
                    >
                      {visibleEpisodes.map((episode) => (
                        <Pressable
                          key={episode.id}
                          accessibilityRole="button"
                          accessibilityLabel={episodeLabel(episode)}
                          accessibilityState={{ selected: selectedEpisode?.id === episode.id }}
                          onPress={() => selectEpisode(episode)}
                          style={[styles.episodeRow, selectedEpisode?.id === episode.id && styles.episodeRowActive]}
                        >
                          <View style={styles.episodeCopy}>
                            <Text numberOfLines={2} style={styles.episodeTitle}>
                              {episode.title}
                            </Text>
                            <Text numberOfLines={1} style={styles.episodeMeta}>
                              {formatDate(episode.pubDate)} {episode.duration ? `- ${formatDuration(episode.duration)}` : ''}
                            </Text>
                          </View>
                          {segmentsByEpisode[episode.id]?.length ? <CheckCircle2 size={18} color="#2A9D8F" /> : <View style={styles.segmentEmptyDot} />}
                        </Pressable>
                      ))}
                    </ScrollView>
                  ) : (
                    <View style={styles.episodeListContent}>
                      {visibleEpisodes.map((episode) => (
                        <Pressable
                          key={episode.id}
                          accessibilityRole="button"
                          accessibilityLabel={episodeLabel(episode)}
                          accessibilityState={{ selected: selectedEpisode?.id === episode.id }}
                          onPress={() => selectEpisode(episode)}
                          style={[styles.episodeRow, selectedEpisode?.id === episode.id && styles.episodeRowActive]}
                        >
                          <View style={styles.episodeCopy}>
                            <Text numberOfLines={2} style={styles.episodeTitle}>
                              {episode.title}
                            </Text>
                            <Text numberOfLines={1} style={styles.episodeMeta}>
                              {formatDate(episode.pubDate)} {episode.duration ? `- ${formatDuration(episode.duration)}` : ''}
                            </Text>
                          </View>
                          {segmentsByEpisode[episode.id]?.length ? <CheckCircle2 size={18} color="#2A9D8F" /> : <View style={styles.segmentEmptyDot} />}
                        </Pressable>
                      ))}
                    </View>
                  ))}
                {filteredEpisodes.length === 0 && (
                  <View style={styles.emptyPanel}>
                    <Search size={26} color="#6B7280" />
                    <Text style={styles.emptyText}>No matching episodes</Text>
                    {episodeQuery.trim() && <IconButton icon={X} label="Clear search" onPress={() => setEpisodeQuery('')} variant="secondary" />}
                  </View>
                )}
                {filteredEpisodes.length > episodePageSize && (
                  <View style={styles.episodeListActions}>
                    {canShowPreviousEpisodes && (
                      <IconButton icon={ChevronLeft} label={`Previous ${previousEpisodeCount}`} onPress={() => setEpisodeOffset((value) => Math.max(value - episodePageSize, 0))} variant="secondary" />
                    )}
                    {canShowNextEpisodes && (
                      <IconButton icon={ChevronRight} label={`Next ${nextEpisodeCount}`} onPress={() => setEpisodeOffset((value) => Math.min(value + episodePageSize, maxEpisodeOffset))} variant="secondary" />
                    )}
                    {canShowPreviousEpisodes && (
                      <IconButton icon={ListMusic} label={`First ${episodePageSize}`} onPress={() => setEpisodeOffset(0)} variant="secondary" />
                    )}
                  </View>
                )}
              </>
            )}
            </View>

            {(isWide || selectedEpisode) && (
              <View style={[styles.playerColumn, isWide && styles.playerPanel]}>
                <PodcastPlayer
                  episode={selectedEpisode}
                  segments={selectedSegments}
                  analyzing={analyzing}
                  onAnalyze={runAnalysis}
                  onUndoSkip={handleUndoSkip}
                  canAnalyze={canAnalyze}
                  analysisUnavailableLabel={analysisUnavailableLabel}
                />
              </View>
            )}
          </View>
          </ScrollView>
        </View>

      <Modal
        {...modalWebProps('OPML Import')}
        accessibilityLabel="OPML Import"
        accessibilityViewIsModal
        animationType="fade"
        transparent
        visible={opmlModalOpen}
        onRequestClose={() => setOpmlModalOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          <View
            accessible
            accessibilityLabel="OPML Import"
            accessibilityViewIsModal
            style={styles.modalCard}
            testID="opml-modal"
          >
            <Text style={styles.modalTitle}>OPML Import</Text>
            <TextInput
              ref={opmlInputRef}
              value={opmlText}
              onChangeText={setOpmlText}
              accessibilityLabel="OPML document"
              multiline
              textAlignVertical="top"
              autoCapitalize="none"
              placeholder="<opml>...</opml>"
              placeholderTextColor="#5F6B63"
              style={styles.opmlInput}
            />
            <View style={styles.modalActions}>
              <IconButton icon={X} label="Cancel" onPress={() => setOpmlModalOpen(false)} variant="ghost" />
              <IconButton icon={Upload} label="Import" onPress={submitOpml} disabled={!opmlText.trim() || loadingFeed} variant="primary" />
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        {...modalWebProps('Analyze Episode', 'analysis-description')}
        accessibilityLabel="Analyze Episode"
        accessibilityViewIsModal
        animationType="fade"
        transparent
        visible={analysisConsentOpen}
        onRequestClose={() => setAnalysisConsentOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          <View
            accessible
            accessibilityLabel="Analyze Episode"
            accessibilityViewIsModal
            style={styles.modalCard}
            testID="analysis-modal"
          >
            <Text style={styles.modalTitle}>Analyze Episode</Text>
            <Text {...describedByTargetWebProps('analysis-description')} style={styles.modalBody}>
              Episode audio is downloaded by your API server and sent to the configured transcription provider. SkipCast stores timestamp metadata, not edited audio.
            </Text>
            <View style={styles.modalActions}>
              <IconButton icon={X} label="Cancel" onPress={() => setAnalysisConsentOpen(false)} variant="ghost" />
              <IconButton icon={Upload} label="Analyze" onPress={confirmAnalysis} disabled={analyzing} variant="primary" />
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        {...modalWebProps('Remove Feed', 'remove-feed-description')}
        accessibilityLabel="Remove Feed"
        accessibilityViewIsModal
        animationType="fade"
        transparent
        visible={Boolean(pendingDeleteFeed)}
        onRequestClose={() => setPendingDeleteFeed(undefined)}
      >
        <View style={styles.modalBackdrop}>
          <View
            accessible
            accessibilityLabel="Remove Feed"
            accessibilityViewIsModal
            style={styles.modalCard}
            testID="remove-feed-modal"
          >
            <Text style={styles.modalTitle}>Remove Feed</Text>
            <Text {...describedByTargetWebProps('remove-feed-description')} style={styles.modalBody}>{pendingDeleteFeed ? `Remove ${pendingDeleteFeed.title} from your library?` : ''}</Text>
            <View style={styles.modalActions}>
              <IconButton icon={X} label="Cancel" onPress={() => setPendingDeleteFeed(undefined)} variant="ghost" />
              <IconButton icon={Trash2} label="Remove" onPress={confirmRemoveFeed} variant="danger" />
            </View>
          </View>
        </View>
      </Modal>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#F6F3ED',
  },
  scrollContent: {
    width: '100%',
    maxWidth: 1320,
    alignSelf: 'center',
    padding: 16,
    paddingBottom: 40,
    gap: 14,
  },
  header: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    flexWrap: 'wrap',
  },
  brandLockup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flexShrink: 1,
  },
  logoMark: {
    width: 44,
    height: 44,
    borderRadius: 8,
    backgroundColor: '#122620',
    alignItems: 'center',
    justifyContent: 'center',
  },
  brand: {
    color: '#122620',
    fontSize: 27,
    fontWeight: '900',
    lineHeight: 31,
  },
  statusText: {
    color: '#5F6B63',
    fontSize: 13,
    fontWeight: '700',
    marginTop: 2,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
  },
  headerActionsCompact: {
    width: '100%',
    justifyContent: 'space-between',
  },
  apiPill: {
    minHeight: 34,
    borderRadius: 8,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  apiPillReady: {
    backgroundColor: '#ECFDF5',
  },
  apiPillChecking: {
    backgroundColor: '#EFF2EE',
  },
  apiPillOffline: {
    backgroundColor: '#FEF3C7',
  },
  apiPillError: {
    backgroundColor: '#FEE2E2',
  },
  apiPillText: {
    color: '#122620',
    fontSize: 12,
    fontWeight: '900',
  },
  feedBar: {
    backgroundColor: '#FFFFFF',
    borderColor: '#D9DED8',
    borderWidth: 1,
    borderRadius: 8,
    padding: 8,
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  feedInput: {
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    color: '#122620',
    fontSize: 15,
    fontWeight: '600',
    paddingHorizontal: 12,
  },
  workspace: {
    gap: 14,
  },
  workspaceWide: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  panel: {
    backgroundColor: '#FFFFFF',
    borderColor: '#D9DED8',
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    gap: 10,
  },
  libraryPanel: {
    width: 300,
  },
  episodesPanel: {
    flex: 1,
    minWidth: 330,
  },
  playerColumn: {
    gap: 14,
  },
  playerPanel: {
    width: 410,
  },
  panelHeader: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  panelTitle: {
    color: '#122620',
    fontSize: 16,
    fontWeight: '900',
  },
  countPill: {
    minWidth: 30,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    overflow: 'hidden',
    textAlign: 'center',
    color: '#122620',
    backgroundColor: '#EFF2EE',
    fontWeight: '900',
  },
  panelButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  searchBar: {
    minHeight: 44,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#CAD3CB',
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    color: '#122620',
    fontSize: 14,
    fontWeight: '700',
  },
  resultText: {
    color: '#5F6B63',
    fontSize: 12,
    fontWeight: '800',
  },
  episodeList: {
    borderRadius: 8,
  },
  episodeListContent: {
    gap: 10,
  },
  episodeListActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  iconOnlyButton: {
    width: 44,
    height: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#EFF2EE',
  },
  iconOnlyButtonPressed: {
    opacity: 0.8,
    transform: [{ translateY: 1 }],
  },
  iconOnlyButtonDisabled: {
    backgroundColor: '#F3F4F6',
    borderColor: '#E5E7EB',
  },
  emptyPanel: {
    minHeight: 160,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  emptyText: {
    color: '#6B7280',
    fontWeight: '700',
  },
  feedRow: {
    minHeight: 70,
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
    padding: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  feedRowActive: {
    backgroundColor: '#EFF7F4',
    borderColor: '#2A9D8F',
  },
  feedThumb: {
    width: 52,
    height: 52,
    borderRadius: 8,
    backgroundColor: '#E5E7EB',
  },
  feedThumbFallback: {
    width: 52,
    height: 52,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#264653',
  },
  feedThumbLetter: {
    color: '#F8FAF7',
    fontWeight: '900',
    fontSize: 18,
  },
  feedCopy: {
    flex: 1,
    minWidth: 0,
  },
  feedTitle: {
    color: '#122620',
    fontSize: 14,
    fontWeight: '900',
    lineHeight: 18,
  },
  feedMeta: {
    color: '#5F6B63',
    marginTop: 3,
    fontSize: 12,
    fontWeight: '700',
  },
  episodeRow: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#EEF0ED',
    backgroundColor: '#FFFFFF',
  },
  episodeRowActive: {
    borderColor: '#2A9D8F',
    backgroundColor: '#F5FBF9',
  },
  episodeCopy: {
    flex: 1,
    minWidth: 0,
  },
  episodeTitle: {
    color: '#122620',
    fontSize: 14,
    fontWeight: '900',
    lineHeight: 18,
  },
  episodeMeta: {
    color: '#5F6B63',
    marginTop: 4,
    fontSize: 12,
    fontWeight: '700',
  },
  segmentEmptyDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#D1D5DB',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(18, 38, 32, 0.34)',
    padding: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalCard: {
    width: '100%',
    maxWidth: 620,
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    padding: 16,
    gap: 14,
  },
  modalTitle: {
    color: '#122620',
    fontSize: 18,
    fontWeight: '900',
  },
  modalBody: {
    color: '#374151',
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 20,
  },
  opmlInput: {
    minHeight: 220,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#CAD3CB',
    color: '#122620',
    fontSize: 13,
    fontWeight: '600',
    padding: 12,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    gap: 10,
  },
});
