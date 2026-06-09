import AsyncStorage from '@react-native-async-storage/async-storage';
import type { AdSegment, PodcastFeed } from '../types';

const FEEDS_KEY = 'skipcast:feeds:v1';
const SEGMENTS_KEY = 'skipcast:segments:v1';

type SegmentMap = Record<string, AdSegment[]>;

export async function loadSavedFeeds(): Promise<PodcastFeed[]> {
  const raw = await AsyncStorage.getItem(FEEDS_KEY);
  if (!raw) {
    return [];
  }

  try {
    return JSON.parse(raw) as PodcastFeed[];
  } catch {
    return [];
  }
}

export async function saveFeeds(feeds: PodcastFeed[]): Promise<void> {
  await AsyncStorage.setItem(FEEDS_KEY, JSON.stringify(feeds));
}

export async function loadSavedSegments(): Promise<SegmentMap> {
  const raw = await AsyncStorage.getItem(SEGMENTS_KEY);
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw) as SegmentMap;
  } catch {
    return {};
  }
}

export async function saveSegments(segments: SegmentMap): Promise<void> {
  await AsyncStorage.setItem(SEGMENTS_KEY, JSON.stringify(segments));
}
