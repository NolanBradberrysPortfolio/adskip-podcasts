export type SegmentCategory = 'host_read_ad' | 'dynamic_ad' | 'network_promo' | 'self_promo' | 'intro' | 'outro';

export type AdSegment = {
  id: string;
  start: number;
  end: number;
  category: SegmentCategory;
  confidence: number;
  label: string;
  source: 'openai-transcript' | 'demo-rule-engine' | 'manual';
  reason?: string;
};

export type PodcastEpisode = {
  id: string;
  title: string;
  podcastTitle: string;
  description?: string;
  pubDate?: string;
  duration?: number;
  audioUrl: string;
  audioType?: string;
  audioLength?: number;
  artworkUrl?: string;
  episodeUrl?: string;
};

export type PodcastFeed = {
  id: string;
  title: string;
  description?: string;
  feedUrl: string;
  siteUrl?: string;
  artworkUrl?: string;
  episodes: PodcastEpisode[];
};

export type AnalysisResult = {
  episodeId: string;
  engine: 'openai-transcript' | 'unavailable';
  status: 'complete' | 'fallback' | 'unavailable';
  message: string;
  segments: AdSegment[];
};
