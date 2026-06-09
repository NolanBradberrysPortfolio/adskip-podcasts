import {
  createElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { ActivityIndicator, AppState, Image, Platform, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import Slider from '@react-native-community/slider';
import { Pause, Play, RotateCcw, ScanLine, SkipForward } from 'lucide-react-native';
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import type { AdSegment, PodcastEpisode } from '../types';
import { clamp, formatDuration } from '../utils/format';
import { IconButton } from './IconButton';

type Props = {
  episode?: PodcastEpisode;
  segments: AdSegment[];
  analyzing: boolean;
  onAnalyze: () => void;
  onUndoSkip: () => void;
  canAnalyze?: boolean;
  analysisUnavailableLabel?: string;
};

const speedOptions = [1, 1.25, 1.5, 2];
const webSliderStyle: CSSProperties = {
  appearance: 'none',
  background: 'transparent',
  cursor: 'pointer',
  height: 44,
  left: 0,
  margin: 0,
  opacity: 0.02,
  position: 'absolute',
  right: 0,
  top: 0,
  width: '100%',
};

function switchWebProps(checked: boolean, onToggle: () => void): Record<string, unknown> {
  if (Platform.OS !== 'web') {
    return {};
  }

  return {
    'aria-checked': checked,
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        onToggle();
      }
    },
  } as Record<string, unknown>;
}

export function PodcastPlayer({
  episode,
  segments,
  analyzing,
  onAnalyze,
  onUndoSkip,
  canAnalyze = true,
  analysisUnavailableLabel = 'AI offline',
}: Props) {
  const [autoSkip, setAutoSkip] = useState(true);
  const [rate, setRate] = useState(1);
  const [isForeground, setIsForeground] = useState(AppState.currentState === 'active');
  const [timelineFocused, setTimelineFocused] = useState(false);
  const lastSkipped = useRef<AdSegment | null>(null);
  const skippedIds = useRef(new Set<string>());

  const source = useMemo(() => {
    if (!episode?.audioUrl) {
      return null;
    }

    return {
      uri: episode.audioUrl,
      name: episode.title,
    };
  }, [episode?.audioUrl, episode?.title]);

  const player = useAudioPlayer(source, {
    updateInterval: 250,
    preferredForwardBufferDuration: 20,
  });
  const status = useAudioPlayerStatus(player);

  useEffect(() => {
    setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'doNotMix',
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setIsForeground(state === 'active');
    });

    return () => subscription.remove();
  }, []);

  useEffect(() => {
    skippedIds.current = new Set();
    lastSkipped.current = null;
  }, [episode?.id]);

  useEffect(() => {
    player.playbackRate = rate;
  }, [player, rate]);

  useEffect(() => {
    if (!autoSkip || !isForeground || !episode || !status.playing) {
      return;
    }

    const current = status.currentTime;
    const segment = segments.find(
      (candidate) =>
        candidate.confidence >= 0.55 &&
        current >= candidate.start &&
        current < candidate.end &&
        !skippedIds.current.has(candidate.id),
    );

    if (!segment) {
      return;
    }

    skippedIds.current.add(segment.id);
    lastSkipped.current = segment;
    player.seekTo(segment.end + 0.2).catch(() => undefined);
  }, [autoSkip, episode, isForeground, player, segments, status.currentTime, status.playing]);

  const duration = status.duration || episode?.duration || 0;
  const progress = duration ? clamp(status.currentTime / duration, 0, 1) : 0;
  const timelineValue = status.currentTime || 0;
  const timelineMaximum = Math.max(duration, 1);
  const timelineText = `${formatDuration(timelineValue)} of ${formatDuration(duration)}`;

  const seekTo = (value: number) => {
    player.seekTo(clamp(value, 0, timelineMaximum)).catch(() => undefined);
  };

  const handleTimelineKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const seekStep = Math.max(5, Math.min(30, timelineMaximum * 0.01));
    let nextValue: number | undefined;

    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      nextValue = timelineValue - seekStep;
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      nextValue = timelineValue + seekStep;
    } else if (event.key === 'PageDown') {
      nextValue = timelineValue - seekStep * 3;
    } else if (event.key === 'PageUp') {
      nextValue = timelineValue + seekStep * 3;
    } else if (event.key === 'Home') {
      nextValue = 0;
    } else if (event.key === 'End') {
      nextValue = timelineMaximum;
    }

    if (nextValue === undefined) {
      return;
    }

    event.preventDefault();
    seekTo(nextValue);
  };

  const toggleAutoSkip = () => {
    setAutoSkip((value) => !value);
  };

  const playPause = () => {
    if (!episode) {
      return;
    }

    if (status.playing) {
      player.pause();
      return;
    }

    player.setActiveForLockScreen(true, {
      title: episode.title,
      artist: episode.podcastTitle,
      artworkUrl: episode.artworkUrl,
    });
    player.play();
  };

  const skipAhead = () => {
    player.seekTo(Math.min((status.currentTime || 0) + 30, duration || Number.MAX_SAFE_INTEGER)).catch(() => undefined);
  };

  const skipBack = () => {
    player.seekTo(Math.max((status.currentTime || 0) - 15, 0)).catch(() => undefined);
  };

  const undoSkip = () => {
    if (!lastSkipped.current) {
      return;
    }

    const segment = lastSkipped.current;
    player.seekTo(Math.max(segment.start, 0)).catch(() => undefined);
    onUndoSkip();
  };

  if (!episode) {
    return (
      <View style={[styles.container, styles.empty]}>
        <ScanLine size={28} color="#6B7280" />
        <Text style={styles.emptyTitle}>No episode selected</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.nowPlaying}>
        {episode.artworkUrl ? (
          <Image source={{ uri: episode.artworkUrl }} style={styles.artwork} />
        ) : (
          <View style={styles.artworkFallback}>
            <Text style={styles.artworkLetter}>{episode.podcastTitle.slice(0, 1).toUpperCase()}</Text>
          </View>
        )}
        <View style={styles.trackMeta}>
          <Text numberOfLines={2} style={styles.episodeTitle}>
            {episode.title}
          </Text>
          <Text numberOfLines={1} style={styles.podcastTitle}>
            {episode.podcastTitle}
          </Text>
        </View>
      </View>

      <View style={[styles.timelineWrap, timelineFocused && styles.timelineFocused]}>
        <View style={styles.timelineTrack}>
          <View style={[styles.timelineFill, { width: `${progress * 100}%` }]} />
          {duration > 0 &&
            segments.map((segment) => (
              <View
                key={segment.id}
                style={[
                  styles.segmentMarker,
                  {
                    left: `${clamp(segment.start / duration, 0, 1) * 100}%`,
                    width: `${Math.max(1.5, clamp((segment.end - segment.start) / duration, 0, 1) * 100)}%`,
                  },
                ]}
              />
            ))}
        </View>
        {Platform.OS === 'web'
          ? createElement('input', {
              'aria-label': 'Playback position',
              'aria-valuetext': timelineText,
              max: timelineMaximum,
              min: 0,
              onBlur: () => setTimelineFocused(false),
              onChange: (event: ChangeEvent<HTMLInputElement>) => seekTo(Number(event.currentTarget.value)),
              onFocus: () => setTimelineFocused(true),
              onKeyDown: handleTimelineKeyDown,
              step: 1,
              style: webSliderStyle,
              type: 'range',
              value: timelineValue,
            })
          : (
            <Slider
              accessibilityLabel="Playback position"
              accessibilityValue={{ text: timelineText }}
              value={timelineValue}
              minimumValue={0}
              maximumValue={timelineMaximum}
              minimumTrackTintColor="transparent"
              maximumTrackTintColor="transparent"
              thumbTintColor="#122620"
              onSlidingComplete={seekTo}
              style={styles.slider}
            />
            )}
      </View>

      <View style={styles.timeRow}>
        <Text style={styles.timeText}>{formatDuration(status.currentTime)}</Text>
        {status.isBuffering && <ActivityIndicator color="#2A9D8F" />}
        <Text style={styles.timeText}>{formatDuration(duration)}</Text>
      </View>

      <View style={styles.controls}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back 15 seconds" onPress={skipBack} style={styles.roundControl}>
          <RotateCcw size={22} color="#122620" />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={status.playing ? 'Pause' : 'Play'} onPress={playPause} style={styles.playControl}>
          {status.playing ? <Pause size={30} color="#F8FAF7" fill="#F8FAF7" /> : <Play size={30} color="#F8FAF7" fill="#F8FAF7" />}
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Forward 30 seconds" onPress={skipAhead} style={styles.roundControl}>
          <SkipForward size={22} color="#122620" />
        </Pressable>
      </View>

      <View style={styles.playerTools}>
        <Pressable
          {...switchWebProps(autoSkip, toggleAutoSkip)}
          accessibilityRole="switch"
          accessibilityLabel="Auto-skip"
          accessibilityState={{ checked: autoSkip }}
          onPress={toggleAutoSkip}
          style={styles.switchRow}
        >
          <Text style={styles.toolLabel}>Auto-skip</Text>
          {Platform.OS === 'web' ? (
            <View style={[styles.switchTrack, autoSkip && styles.switchTrackOn]}>
              <View style={[styles.switchThumb, autoSkip && styles.switchThumbOn]} />
            </View>
          ) : (
            <View pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
              <Switch
                value={autoSkip}
                onValueChange={setAutoSkip}
                trackColor={{ false: '#D1D5DB', true: '#9BD7CA' }}
                thumbColor={autoSkip ? '#122620' : '#F8FAF7'}
              />
            </View>
          )}
        </Pressable>
        <IconButton
          icon={ScanLine}
          label={analyzing ? 'Analyzing' : canAnalyze ? 'Analyze' : analysisUnavailableLabel}
          onPress={onAnalyze}
          disabled={analyzing || !canAnalyze}
        />
        <IconButton icon={RotateCcw} label="Undo skip" onPress={undoSkip} disabled={!lastSkipped.current} variant="ghost" />
      </View>

      <View style={styles.speedRow}>
        {speedOptions.map((option) => (
          <Pressable
            key={option}
            accessibilityRole="button"
            accessibilityLabel={`${option}x`}
            accessibilityState={{ selected: rate === option }}
            onPress={() => setRate(option)}
            style={[styles.speedOption, rate === option && styles.speedOptionActive]}
          >
            <Text style={[styles.speedText, rate === option && styles.speedTextActive]}>{option}x</Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.segmentList}>
        <Text style={styles.sectionTitle}>Skip segments</Text>
        {segments.length === 0 ? (
          <Text style={styles.mutedText}>None</Text>
        ) : (
          segments.map((segment) => (
            <Pressable
              key={segment.id}
              accessibilityRole="button"
              accessibilityLabel={`${segment.label} at ${formatDuration(segment.start)}`}
              onPress={() => player.seekTo(segment.start).catch(() => undefined)}
              style={styles.segmentRow}
            >
              <View style={styles.segmentDot} />
              <View style={styles.segmentCopy}>
                <Text numberOfLines={1} style={styles.segmentLabel}>
                  {segment.label}
                </Text>
                <Text style={styles.segmentMeta}>
                  {formatDuration(segment.start)} - {formatDuration(segment.end)} - {Math.round(segment.confidence * 100)}%
                </Text>
              </View>
            </Pressable>
          ))
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#FFFFFF',
    borderColor: '#D9DED8',
    borderWidth: 1,
    borderRadius: 8,
    padding: 16,
    gap: 14,
  },
  empty: {
    minHeight: 320,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: {
    color: '#374151',
    fontSize: 16,
    fontWeight: '700',
  },
  nowPlaying: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
  },
  artwork: {
    width: 72,
    height: 72,
    borderRadius: 8,
    backgroundColor: '#E5E7EB',
  },
  artworkFallback: {
    width: 72,
    height: 72,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#264653',
  },
  artworkLetter: {
    color: '#F8FAF7',
    fontSize: 28,
    fontWeight: '900',
  },
  trackMeta: {
    flex: 1,
    minWidth: 0,
  },
  episodeTitle: {
    color: '#122620',
    fontSize: 18,
    fontWeight: '900',
    lineHeight: 23,
  },
  podcastTitle: {
    color: '#5F6B63',
    marginTop: 4,
    fontSize: 13,
    fontWeight: '700',
  },
  timelineWrap: {
    position: 'relative',
    height: 44,
    justifyContent: 'center',
    borderRadius: 8,
  },
  timelineFocused: {
    borderWidth: 2,
    borderColor: '#122620',
  },
  timelineTrack: {
    position: 'absolute',
    left: 4,
    right: 4,
    height: 10,
    borderRadius: 5,
    overflow: 'hidden',
    backgroundColor: '#E5E7EB',
  },
  timelineFill: {
    height: '100%',
    backgroundColor: '#087F73',
  },
  segmentMarker: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    backgroundColor: '#C2410C',
  },
  slider: {
    height: 44,
  },
  timeRow: {
    minHeight: 20,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  timeText: {
    color: '#5F6B63',
    fontSize: 12,
    fontWeight: '700',
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 18,
  },
  roundControl: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#EFF2EE',
  },
  playControl: {
    width: 62,
    height: 62,
    borderRadius: 31,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#122620',
  },
  playerTools: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 10,
  },
  switchRow: {
    minHeight: 44,
    borderRadius: 8,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#EFF2EE',
  },
  switchTrack: {
    width: 42,
    height: 24,
    borderRadius: 12,
    padding: 3,
    backgroundColor: '#D1D5DB',
  },
  switchTrackOn: {
    backgroundColor: '#9BD7CA',
  },
  switchThumb: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#F8FAF7',
  },
  switchThumbOn: {
    backgroundColor: '#122620',
    transform: [{ translateX: 18 }],
  },
  toolLabel: {
    color: '#122620',
    fontWeight: '800',
  },
  speedRow: {
    flexDirection: 'row',
    backgroundColor: '#EFF2EE',
    borderRadius: 8,
    padding: 4,
  },
  speedOption: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
  },
  speedOptionActive: {
    backgroundColor: '#FFFFFF',
  },
  speedText: {
    color: '#5F6B63',
    fontSize: 13,
    fontWeight: '800',
  },
  speedTextActive: {
    color: '#122620',
  },
  segmentList: {
    gap: 8,
  },
  sectionTitle: {
    color: '#122620',
    fontSize: 14,
    fontWeight: '900',
  },
  mutedText: {
    color: '#6B7280',
    fontSize: 13,
    fontWeight: '600',
  },
  segmentRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    borderTopColor: '#EEF0ED',
    borderTopWidth: 1,
  },
  segmentDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#C2410C',
  },
  segmentCopy: {
    flex: 1,
    minWidth: 0,
  },
  segmentLabel: {
    color: '#122620',
    fontSize: 13,
    fontWeight: '800',
  },
  segmentMeta: {
    color: '#6B7280',
    fontSize: 12,
    marginTop: 2,
  },
});
