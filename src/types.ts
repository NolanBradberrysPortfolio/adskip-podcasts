export type SegmentCategory = 'host_read_ad' | 'dynamic_ad' | 'network_promo' | 'self_promo' | 'intro' | 'outro';

export type AdSegment = {
  id: string;
  start: number;
  end: number;
  category: SegmentCategory;
  confidence: number;
  label: string;
  source: 'openai-ad-model' | 'codex-ad-model' | 'openai-transcript' | 'local-whisper-transcript' | 'demo-rule-engine' | 'manual';
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

export type SpotifyImportShow = {
  title: string;
  publisher?: string;
  spotifyUrl?: string;
  imageUrl?: string;
};

export type ImportFeedCandidate = {
  id: string;
  source: 'spotify';
  status: 'matched' | 'needs_review' | 'unavailable';
  title: string;
  publisher?: string;
  feedUrl?: string;
  artworkUrl?: string;
  confidence: number;
  reason: string;
  externalUrl?: string;
};

export type AnalysisResult = {
  episodeId: string;
  engine: 'openai-ad-model' | 'codex-ad-model' | 'openai-transcript' | 'local-whisper-transcript' | 'unavailable';
  status: 'complete' | 'fallback' | 'unavailable';
  message: string;
  segments: AdSegment[];
};
