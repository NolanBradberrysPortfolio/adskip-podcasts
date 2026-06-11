import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ActivityIndicator, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { CheckCircle2, FileText, ListMusic, Music2, Upload, X } from 'lucide-react-native';
import { fetchSpotifyImportResult, fetchSpotifyImportStatus, importOpml, matchPodcastShows, spotifyConnectUrl } from '../services/api';
import type { ImportFeedCandidate, SpotifyImportShow } from '../types';
import { IconButton } from './IconButton';

export type ImportMode = 'names' | 'apple' | 'opml';

export type ImportProgress = {
  completed: number;
  total: number;
};

export type ImportSummary = {
  imported: number;
  failed: number;
  skipped: number;
  rejected?: number;
  capped?: number;
};

export type ImportMetadata = {
  rejected?: number;
  capped?: number;
};

type Props = {
  visible: boolean;
  apiReachable: boolean;
  busy: boolean;
  initialMode?: ImportMode;
  initialFocusRef?: RefObject<TextInput | null>;
  spotifyResultToken?: string;
  onClearSpotifyResultToken: (consumed?: boolean) => void;
  onClose: () => void;
  onImportFeedUrls: (urls: string[], source: string, onProgress?: (progress: ImportProgress) => void, metadata?: ImportMetadata) => Promise<ImportSummary>;
};

function modalWebProps(): Record<string, unknown> {
  if (Platform.OS !== 'web') {
    return {};
  }

  return {
    'aria-label': 'Import Podcasts',
    'aria-modal': true,
    role: 'dialog',
  } as Record<string, unknown>;
}

function importModeLabel(mode: ImportMode): string {
  return mode === 'names' ? 'Find by name' : mode === 'apple' ? 'Apple Podcasts' : 'OPML file';
}

function parseSpotifyShows(text: string): SpotifyImportShow[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => {
          if (typeof item === 'string') {
            return { title: item };
          }

          if (!item || typeof item !== 'object') {
            return undefined;
          }

          const record = item as Record<string, unknown>;
          const title = typeof record.title === 'string' ? record.title : typeof record.name === 'string' ? record.name : '';
          if (!title.trim()) {
            return undefined;
          }

          return {
            title,
            publisher: typeof record.publisher === 'string' ? record.publisher : undefined,
            spotifyUrl: typeof record.spotifyUrl === 'string' ? record.spotifyUrl : undefined,
            imageUrl: typeof record.imageUrl === 'string' ? record.imageUrl : undefined,
          };
        })
        .filter((show): show is SpotifyImportShow => Boolean(show?.title?.trim()));
    }
  } catch {
    // Fall through to line parsing.
  }

  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [title, publisher] = line.includes('|') ? line.split('|') : line.split(/\s+-\s+/);
      return {
        title: title.trim(),
        publisher: publisher?.trim() || undefined,
      };
    })
    .filter((show) => show.title);
}

function dedupeSpotifyMatches(matches: ImportFeedCandidate[]): ImportFeedCandidate[] {
  const seen = new Set<string>();
  const unique: ImportFeedCandidate[] = [];

  for (const match of matches) {
    const key = match.feedUrl ? `feed:${match.feedUrl}` : `match:${match.id}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(match);
  }

  return unique;
}

export function ImportWizard({
  visible,
  apiReachable,
  busy,
  initialMode = 'apple',
  initialFocusRef,
  spotifyResultToken,
  onClearSpotifyResultToken,
  onClose,
  onImportFeedUrls,
}: Props) {
  const [mode, setMode] = useState<ImportMode>(initialMode);
  const [opmlText, setOpmlText] = useState('');
  const [fileName, setFileName] = useState('');
  const [status, setStatus] = useState('');
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState<ImportProgress>();
  const [spotifyConfigured, setSpotifyConfigured] = useState<boolean>();
  const [spotifyShowsText, setSpotifyShowsText] = useState('');
  const [spotifyMatches, setSpotifyMatches] = useState<ImportFeedCandidate[]>([]);
  const [selectedMatchIds, setSelectedMatchIds] = useState<Set<string>>(new Set());
  const onClearSpotifyResultTokenRef = useRef(onClearSpotifyResultToken);
  const disabled = busy || working || !apiReachable;

  const selectedSpotifyUrls = useMemo(
    () => spotifyMatches
      .filter((match) => selectedMatchIds.has(match.id) && match.feedUrl)
      .map((match) => match.feedUrl!),
    [selectedMatchIds, spotifyMatches],
  );

  useEffect(() => {
    if (!visible || !apiReachable) {
      return;
    }

    fetchSpotifyImportStatus()
      .then((result) => setSpotifyConfigured(result.configured))
      .catch(() => setSpotifyConfigured(false));
  }, [apiReachable, visible]);

  useEffect(() => {
    onClearSpotifyResultTokenRef.current = onClearSpotifyResultToken;
  }, [onClearSpotifyResultToken]);

  useEffect(() => {
    if (visible && !spotifyResultToken) {
      setMode(initialMode);
    }
  }, [initialMode, spotifyResultToken, visible]);

  useEffect(() => {
    if (!visible || !spotifyResultToken) {
      return;
    }

    let active = true;
    let loaded = false;
    setMode('names');
    setWorking(true);
    setStatus('Loading saved show matches');

    fetchSpotifyImportResult(spotifyResultToken)
      .then((result) => {
        if (!active) {
          return;
        }

        receiveSpotifyMatches(result.matches, `Matched ${result.matches.length} of ${result.total} saved shows`);
        loaded = true;
      })
      .catch((error) => {
        if (active) {
          setStatus(error instanceof Error ? error.message : 'Saved show import result failed');
        }
      })
      .finally(() => {
        if (active) {
          setWorking(false);
          if (loaded) {
            onClearSpotifyResultTokenRef.current(true);
          }
        }
      });

    return () => {
      active = false;
    };
  }, [spotifyResultToken, visible]);

  const receiveSpotifyMatches = (matches: ImportFeedCandidate[], nextStatus: string) => {
    const uniqueMatches = dedupeSpotifyMatches(matches);
    setSpotifyMatches(uniqueMatches);
    setSelectedMatchIds(new Set(uniqueMatches.filter((match) => match.status === 'matched' && match.feedUrl).map((match) => match.id)));
    setStatus(uniqueMatches.length === matches.length ? nextStatus : `${nextStatus}; ${matches.length - uniqueMatches.length} duplicate hidden`);
  };

  const chooseOpmlFile = () => {
    if (Platform.OS !== 'web') {
      chooseNativeOpmlFile();
      return;
    }

    if (typeof document === 'undefined') {
      setStatus('Paste OPML on this device');
      return;
    }

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.opml,.xml,text/xml,application/xml,text/x-opml';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        setOpmlText(String(reader.result || ''));
        setFileName(file.name);
        setStatus(`Loaded ${file.name}`);
      };
      reader.onerror = () => setStatus('OPML file could not be read');
      reader.readAsText(file);
    };
    input.click();
  };

  const chooseNativeOpmlFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
        type: ['text/xml', 'application/xml', 'text/x-opml', '*/*'],
      });

      if (result.canceled || !result.assets?.[0]) {
        return;
      }

      const asset = result.assets[0];
      const contents = await FileSystem.readAsStringAsync(asset.uri);
      setOpmlText(contents);
      setFileName(asset.name || 'Selected OPML file');
      setStatus(`Loaded ${asset.name || 'OPML file'}`);
    } catch {
      setStatus('OPML file could not be read');
    }
  };

  const submitOpml = async () => {
    const trimmed = opmlText.trim();
    if (!trimmed) {
      return;
    }

    setWorking(true);
    setProgress(undefined);
    setStatus('Reading OPML');

    try {
      const result = await importOpml(trimmed);
      if (!result.feeds.length && !result.rejected && !result.capped) {
        setStatus('No RSS subscriptions found in OPML');
        return;
      }

      const summary = await onImportFeedUrls(result.feeds, importModeLabel(mode), setProgress, {
        capped: result.capped || 0,
        rejected: result.rejected || 0,
      });
      const failedTotal = summary.failed + (summary.rejected || 0);
      setStatus(failedTotal || summary.capped
        ? `Imported ${summary.imported}; ${failedTotal} failed; ${summary.skipped} skipped; ${summary.capped || 0} capped`
        : `Imported ${summary.imported}; ${summary.skipped} skipped`);
      setOpmlText('');
      setFileName('');
      onClose();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'OPML import failed');
    } finally {
      setProgress(undefined);
      setWorking(false);
    }
  };

  const connectSpotify = async () => {
    if (Platform.OS === 'web' && typeof window === 'undefined') {
      setStatus('Spotify sign-in is unavailable in this browser');
      return;
    }

    try {
      const returnTo = Platform.OS === 'web' ? `${window.location.origin}${window.location.pathname}` : 'skipcast://spotify-import';
      await Linking.openURL(spotifyConnectUrl(returnTo));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Spotify sign-in failed');
    }
  };

  const matchShows = async () => {
    const shows = parseSpotifyShows(spotifyShowsText).slice(0, 100);
    if (!shows.length) {
      setStatus('Add at least one podcast name');
      return;
    }

    setWorking(true);
    setStatus('Finding podcast RSS feeds');

    try {
      const result = await matchPodcastShows(shows);
      receiveSpotifyMatches(result.matches, `Found ${result.matches.length} RSS matches from ${result.total} podcasts`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Podcast matching failed');
    } finally {
      setWorking(false);
    }
  };

  const importSpotifyMatches = async () => {
    if (!selectedSpotifyUrls.length) {
      setStatus('Select at least one matched feed');
      return;
    }

    setWorking(true);
    setProgress(undefined);
    setStatus('Saving matched podcasts');

    try {
      const summary = await onImportFeedUrls(selectedSpotifyUrls, 'Podcast names', setProgress);
      setStatus(summary.failed
        ? `Imported ${summary.imported}; ${summary.failed} failed; ${summary.skipped} skipped`
        : `Imported ${summary.imported}; ${summary.skipped} skipped`);
      onClose();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Podcast import failed');
    } finally {
      setProgress(undefined);
      setWorking(false);
    }
  };

  const toggleMatch = (match: ImportFeedCandidate) => {
    if (!match.feedUrl) {
      return;
    }

    setSelectedMatchIds((current) => {
      const next = new Set(current);
      if (next.has(match.id)) {
        next.delete(match.id);
      } else {
        next.add(match.id);
      }
      return next;
    });
  };

  return (
    <Modal
      {...modalWebProps()}
      accessibilityLabel="Import Podcasts"
      accessibilityViewIsModal
      animationType="fade"
      transparent
      visible={visible}
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <View accessible accessibilityLabel="Import Podcasts" accessibilityViewIsModal style={styles.card} testID="opml-modal">
          <View style={styles.header}>
            <Text style={styles.title}>Import Podcasts</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Close import" onPress={onClose} hitSlop={8} style={styles.closeButton}>
              <X size={20} color="#122620" />
            </Pressable>
          </View>

          <View style={styles.modeRow}>
            {(['names', 'apple', 'opml'] as ImportMode[]).map((candidate) => (
              <Pressable
                key={candidate}
                accessibilityRole="button"
                accessibilityLabel={importModeLabel(candidate)}
                accessibilityState={{ selected: mode === candidate }}
                onPress={() => setMode(candidate)}
                style={[styles.modeButton, mode === candidate && styles.modeButtonActive]}
              >
                <Text style={[styles.modeText, mode === candidate && styles.modeTextActive]}>{importModeLabel(candidate)}</Text>
              </Pressable>
            ))}
          </View>

          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            {(mode === 'apple' || mode === 'opml') && (
              <>
                <View style={styles.infoRow}>
                  <FileText size={18} color="#0F766E" />
                  <Text style={styles.infoText}>
                    {mode === 'apple'
                      ? 'Apple Podcasts imports through an OPML subscription file.'
                      : 'OPML brings over subscriptions from any podcast app that can export it.'}
                  </Text>
                </View>
                <View style={styles.uploadRow}>
                  <IconButton icon={Upload} label="Choose OPML file" onPress={chooseOpmlFile} disabled={disabled} variant="secondary" style={styles.fullButton} />
                  {fileName ? <Text style={styles.fileName}>{fileName}</Text> : null}
                </View>
                <TextInput
                  ref={initialFocusRef}
                  value={opmlText}
                  onChangeText={setOpmlText}
                  accessibilityLabel="OPML document"
                  multiline
                  textAlignVertical="top"
                  autoCapitalize="none"
                  placeholder="<opml>...</opml>"
                  placeholderTextColor="#5F6B63"
                  style={styles.textArea}
                />
                <IconButton icon={Upload} label="Import OPML" onPress={submitOpml} disabled={disabled || !opmlText.trim()} variant="primary" style={styles.fullButton} />
              </>
            )}

            {mode === 'names' && (
              <>
                <View style={styles.infoRow}>
                  <Music2 size={18} color="#0F766E" />
                  <Text style={styles.infoText}>
                    Type or paste the podcasts you listen to. SkipCast finds public RSS feeds and lets you review matches before saving.
                  </Text>
                </View>
                <IconButton
                  icon={ListMusic}
                  label={spotifyConfigured ? 'Connect Spotify' : 'Spotify sign-in needs backend setup'}
                  onPress={connectSpotify}
                  disabled={disabled || spotifyConfigured === false}
                  variant="secondary"
                  style={styles.fullButton}
                />
                {spotifyConfigured === false && (
                  <Text style={styles.helperText}>Spotify sign-in is not configured yet. Name matching works now.</Text>
                )}
                <TextInput
                  value={spotifyShowsText}
                  onChangeText={setSpotifyShowsText}
                  accessibilityLabel="Podcast names"
                  multiline
                  textAlignVertical="top"
                  autoCapitalize="none"
                  placeholder={'Up First | NPR\nRadiolab | WNYC Studios'}
                  placeholderTextColor="#5F6B63"
                  style={styles.spotifyInput}
                />
                <IconButton icon={CheckCircle2} label="Find RSS feeds" onPress={matchShows} disabled={disabled || !spotifyShowsText.trim()} variant="primary" style={styles.fullButton} />
                {spotifyMatches.length > 0 && (
                  <View style={styles.matchList}>
                    {spotifyMatches.map((match) => {
                      const selected = selectedMatchIds.has(match.id);
                      return (
                        <Pressable
                          key={match.id}
                          accessibilityRole="checkbox"
                          accessibilityLabel={`${match.title}, ${match.status}`}
                          accessibilityState={{ checked: selected, disabled: !match.feedUrl }}
                          disabled={!match.feedUrl}
                          onPress={() => toggleMatch(match)}
                          style={[styles.matchRow, selected && styles.matchRowSelected, !match.feedUrl && styles.matchRowDisabled]}
                        >
                          <View style={styles.matchCopy}>
                            <Text numberOfLines={2} style={styles.matchTitle}>{match.title}</Text>
                            <Text numberOfLines={1} style={styles.matchMeta}>
                              {match.publisher || 'Unknown publisher'} - {match.status.replace('_', ' ')} - {Math.round(match.confidence * 100)}%
                            </Text>
                          </View>
                          {selected ? <CheckCircle2 size={18} color="#0F766E" /> : <View style={styles.emptyCheck} />}
                        </Pressable>
                      );
                    })}
                  </View>
                )}
                {spotifyMatches.length > 0 && (
                  <IconButton icon={Upload} label="Save selected podcasts" onPress={importSpotifyMatches} disabled={disabled || !selectedSpotifyUrls.length} variant="primary" style={styles.fullButton} />
                )}
              </>
            )}
          </ScrollView>

          <View style={styles.footer}>
            {(working || busy) && <ActivityIndicator color="#2A9D8F" />}
            {progress && <Text style={styles.progressText}>{progress.completed}/{progress.total}</Text>}
            <Text accessibilityLiveRegion="polite" style={styles.statusText}>{status || (apiReachable ? 'Ready' : 'API unavailable')}</Text>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(18, 38, 32, 0.34)',
    padding: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    width: '100%',
    maxWidth: 620,
    maxHeight: '92%',
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    padding: 14,
    gap: 12,
  },
  header: {
    minHeight: 36,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
  },
  title: {
    color: '#122620',
    fontSize: 18,
    fontWeight: '900',
  },
  closeButton: {
    width: 44,
    height: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#EFF2EE',
  },
  modeRow: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },
  modeButton: {
    minHeight: 44,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#CAD3CB',
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeButtonActive: {
    borderColor: '#0F766E',
    backgroundColor: '#ECFDF5',
  },
  modeText: {
    color: '#374151',
    fontSize: 13,
    fontWeight: '900',
  },
  modeTextActive: {
    color: '#122620',
  },
  body: {
    gap: 12,
  },
  infoRow: {
    borderRadius: 8,
    backgroundColor: '#ECFDF5',
    padding: 10,
    flexDirection: 'row',
    gap: 8,
    alignItems: 'flex-start',
  },
  infoText: {
    flex: 1,
    minWidth: 0,
    color: '#122620',
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 18,
  },
  uploadRow: {
    gap: 8,
  },
  fullButton: {
    width: '100%',
  },
  fileName: {
    color: '#5F6B63',
    fontSize: 12,
    fontWeight: '800',
  },
  helperText: {
    color: '#5F6B63',
    fontSize: 12,
    fontWeight: '800',
    lineHeight: 17,
  },
  textArea: {
    minHeight: 180,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#CAD3CB',
    color: '#122620',
    fontSize: 13,
    fontWeight: '600',
    padding: 12,
  },
  spotifyInput: {
    minHeight: 120,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#CAD3CB',
    color: '#122620',
    fontSize: 13,
    fontWeight: '600',
    padding: 12,
  },
  matchList: {
    gap: 8,
  },
  matchRow: {
    minHeight: 64,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    padding: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  matchRowSelected: {
    backgroundColor: '#F5FBF9',
    borderColor: '#0F766E',
  },
  matchRowDisabled: {
    opacity: 0.64,
  },
  matchCopy: {
    flex: 1,
    minWidth: 0,
  },
  matchTitle: {
    color: '#122620',
    fontSize: 14,
    fontWeight: '900',
    lineHeight: 18,
  },
  matchMeta: {
    marginTop: 3,
    color: '#5F6B63',
    fontSize: 12,
    fontWeight: '700',
  },
  emptyCheck: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: '#CAD3CB',
  },
  footer: {
    minHeight: 24,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  progressText: {
    color: '#0F766E',
    fontSize: 12,
    fontWeight: '900',
  },
  statusText: {
    flex: 1,
    minWidth: 0,
    color: '#5F6B63',
    fontSize: 12,
    fontWeight: '800',
  },
});
