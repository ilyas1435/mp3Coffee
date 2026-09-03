import { useState, useEffect, useRef } from "react";
import {
  useConversions,
  useCreateConversion,
  useDeleteAllConversions,
  useDeleteConversion,
  useDiskSpace,
  useCancelConversion,
  usePlaylistInfo,
  useBulkDownload,
  useRenameConversion,
  useArchiveUpload,
  useIACredentials,
  useSettings,
  useSaveSettings,
} from "@/hooks/use-conversions";
import { ConversionCard } from "@/components/ConversionCard";
import { ArchiveManager } from "@/components/ArchiveManager";
import { CookiesManager } from "@/components/CookiesManager";
import {
  Loader2, Music, Settings2, Link2, ChevronDown, History, ListVideo,
  HardDrive, Trash2, Download, X, CheckSquare, Square, CheckCheck, Archive,
  Server, ExternalLink, Pencil, Check, Moon, Sun, Languages,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// ─── Dark mode ───────────────────────────────────────────────────────────────
const THEME_KEY = "mp3conv-theme";
function getInitialDark(): boolean {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved !== null) return saved === "dark";
  } catch {}
  return true; // default to dark
}
function applyTheme(dark: boolean) {
  document.documentElement.classList.toggle("dark", dark);
  try { localStorage.setItem(THEME_KEY, dark ? "dark" : "light"); } catch {}
}
// Apply on load before first render to avoid flash
applyTheme(getInitialDark());

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const DOWNLOADED_KEY = "mp3conv-downloaded";
const LAST_IA_URL_KEY = "mp3conv-last-ia-url";
const IA_ACCOUNT_URL_KEY = "mp3conv-ia-account-url";
const DEFAULT_IA_ACCOUNT_URL = "https://archive.org/details/@ilyas143555";

function loadDownloaded(): Set<number> {
  try {
    const raw = localStorage.getItem(DOWNLOADED_KEY);
    return new Set(JSON.parse(raw ?? "[]") as number[]);
  } catch {
    return new Set();
  }
}

interface PlaylistPreview {
  url: string;
  entries: { id: string; title: string; url: string }[];
  selected: Set<number>;
}

const DOWNLOAD_SERVERS = [
  { value: "best",              label: "⭐ Best Effort — yt-dlp cycles all YouTube clients" },
  { value: "android_testsuite", label: "YouTube Android Test Suite client" },
  { value: "ios",               label: "YouTube iOS client" },
  { value: "android",           label: "YouTube Android client" },
  { value: "mweb",              label: "YouTube Mobile Web client" },
  { value: "tv",                label: "YouTube TV Embedded client" },
  { value: "direct",            label: "Direct yt-dlp (no client override)" },
] as const;

const AUDIO_LANGUAGES = [
  { value: "original", label: "Original audio track" },
  { value: "ar",       label: "Arabic (ar) — دبلجة عربية" },
  { value: "en",       label: "English (en)" },
  { value: "fr",       label: "French (fr)" },
  { value: "de",       label: "German (de)" },
  { value: "es",       label: "Spanish (es)" },
  { value: "tr",       label: "Turkish (tr)" },
] as const;

export default function Home() {
  const { data: dbSettings, isSuccess: settingsLoaded } = useSettings();
  const { mutate: saveSettings } = useSaveSettings();
  const settingsApplied = useRef(false);

  const [darkMode, setDarkMode] = useState(getInitialDark);

  const toggleDark = () => {
    setDarkMode(prev => {
      applyTheme(!prev);
      return !prev;
    });
  };

  const [url, setUrl] = useState("");
  const [bitrate, setBitrate] = useState<number>(16);
  const [bitrateType, setBitrateType] = useState<"abr" | "vbr" | "cbr">("abr");
  const [sampleRate, setSampleRate] = useState<number>(8000);
  const [channels, setChannels] = useState<number>(1);
  const [speed, setSpeed] = useState<number>(1.0);
  const [downloadServer, setDownloadServer] = useState<string>("best");
  const [audioLanguage, setAudioLanguage] = useState<string>("original");
  const [cookiesEnabled, setCookiesEnabled] = useState<boolean>(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [downloadedIds, setDownloadedIds] = useState<Set<number>>(loadDownloaded);
  const [playlistPreview, setPlaylistPreview] = useState<PlaylistPreview | null>(null);
  const [lastIaUrl, setLastIaUrl] = useState<string>(() => localStorage.getItem(LAST_IA_URL_KEY) ?? "");
  const [iaAccountUrl, setIaAccountUrl] = useState<string>(
    () => localStorage.getItem(IA_ACCOUNT_URL_KEY) ?? DEFAULT_IA_ACCOUNT_URL,
  );
  const [editingIaUrl, setEditingIaUrl] = useState(false);
  const [iaUrlDraft, setIaUrlDraft] = useState("");

  // Apply DB settings once loaded (one-time hydration)
  useEffect(() => {
    if (!settingsLoaded || settingsApplied.current || !dbSettings) return;
    settingsApplied.current = true;
    if (dbSettings.bitrate != null) setBitrate(dbSettings.bitrate);
    if (dbSettings.bitrateType) setBitrateType(dbSettings.bitrateType as "abr" | "vbr" | "cbr");
    if (dbSettings.sampleRate != null) setSampleRate(dbSettings.sampleRate);
    if (dbSettings.channels != null) setChannels(dbSettings.channels);
    if (dbSettings.speed != null) setSpeed(dbSettings.speed);
    if (dbSettings.downloadServer) setDownloadServer(dbSettings.downloadServer);
    if (dbSettings.cookiesEnabled != null) setCookiesEnabled(dbSettings.cookiesEnabled);
    if (dbSettings.audioLanguage) setAudioLanguage(dbSettings.audioLanguage);
  }, [settingsLoaded, dbSettings]);

  // Persist settings to DB on change (after initial hydration)
  useEffect(() => {
    if (!settingsApplied.current) return;
    saveSettings({ bitrate, bitrateType, sampleRate, channels, speed, downloadServer, cookiesEnabled, audioLanguage });
  }, [bitrate, bitrateType, sampleRate, channels, speed, downloadServer, cookiesEnabled, audioLanguage]);

  const markDownloaded = (id: number) => {
    setDownloadedIds(prev => {
      const next = new Set(prev);
      next.add(id);
      localStorage.setItem(DOWNLOADED_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  const { data: conversions, isLoading } = useConversions();
  const { mutate: createConversion, isPending } = useCreateConversion();
  const { mutate: deleteAll, isPending: isDeleting } = useDeleteAllConversions();
  const { mutate: deleteOne, isPending: isDeletingOne, variables: deletingOneId } = useDeleteConversion();
  const { mutate: cancelConversion, isPending: isCancelPending, variables: cancellingId } = useCancelConversion();
  const { mutateAsync: checkPlaylist, isPending: isChecking } = usePlaylistInfo();
  const { mutate: bulkDownload, isPending: isZipping } = useBulkDownload();
  const { mutate: renameConversion, isPending: isRenaming, variables: renamingId } = useRenameConversion();
  const { startUpload, isUploading, jobStatus, clearJob } = useArchiveUpload();
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const { data: diskSpace } = useDiskSpace();
  const { data: iaCredentials } = useIACredentials();
  const { toast } = useToast();

  // Show toast when archive upload finishes
  useEffect(() => {
    if (!jobStatus) return;
    if (jobStatus.status === "done") {
      const url = jobStatus.iaPageUrl;
      setLastIaUrl(url);
      localStorage.setItem(LAST_IA_URL_KEY, url);
      toast({
        title: `Uploaded ${jobStatus.completed} file(s) to Archive.org`,
        description: `The item page takes 2–5 minutes to go live. Check your Archive.org account to confirm.`,
      });
      clearJob();
      setSelectedIds(new Set());
    } else if (jobStatus.status === "error") {
      toast({ title: "Archive.org upload failed", description: jobStatus.error ?? "Unknown error", variant: "destructive" });
      clearJob();
    }
  }, [jobStatus?.status]);

  const startConversion = (urlToConvert: string, selectedItems?: number[], sourceUrls?: string[]) => {
    createConversion(
      {
        youtubeUrl: urlToConvert, bitrate, bitrateType, sampleRate, channels, speed,
        downloadServer, audioLanguage,
        ...(selectedItems ? { selectedItems } : {}),
         ...(sourceUrls && sourceUrls.length > 1 ? { sourceUrls } : {}),
      } as Parameters<typeof createConversion>[0],
      {
        onSuccess: () => {
          setUrl("");
          setPlaylistPreview(null);
          toast({ title: "Conversion started", description: "Processing in the background." });
        },
        onError: (err) => {
          toast({ title: "Error", description: err.message, variant: "destructive" });
        },
      }
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const urls = [...new Set(url.split(",").map(value => value.trim()).filter(Boolean))];
    if (urls.length === 0) return;
    if (urls.some(candidate => !/^https?:\/\/\S+$/i.test(candidate))) {
      toast({ title: "Check the URLs", description: "Use full http:// or https:// links separated by commas.", variant: "destructive" });
      return;
    }
    if (urls.length > 50) {
      toast({ title: "Too many URLs", description: "Submit up to 50 links in one ZIP job.", variant: "destructive" });
      return;
    }
    if (urls.length > 1) {
      startConversion(urls[0], undefined, urls);
      return;
    }
    const trimmed = urls[0];

    try {
      const info = await checkPlaylist(trimmed);
      if (info.isPlaylist && info.entries.length > 1) {
        setPlaylistPreview({
          url: trimmed,
          entries: info.entries,
          selected: new Set(info.entries.map((_, i) => i)),
        });
        return;
      }
    } catch {
      // Fall back to direct conversion if check fails
    }

    startConversion(trimmed);
  };

  const handleDeleteSelected = () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 4000);
      return;
    }
    setConfirmDelete(false);
    deleteAll(ids, {
      onSuccess: (data) => {
        toast({ title: "Deleted", description: `Removed ${data.deleted} file${data.deleted !== 1 ? "s" : ""}.` });
        setSelectedIds(new Set());
      },
      onError: () => {
        toast({ title: "Error deleting", variant: "destructive" });
      },
    });
  };

  const handleDeleteOne = (id: number) => {
    deleteOne(id, {
      onSuccess: () => {
        setSelectedIds(prev => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      },
      onError: () => {
        toast({ title: "Error deleting", variant: "destructive" });
      },
    });
  };

  const handleDownloadSelected = () => {
    const ids = [...selectedIds].filter(id => {
      const c = conversions?.find(x => x.id === id);
      return c?.status === "done";
    });
    if (ids.length === 0) {
      toast({ title: "Nothing to bundle", description: "Select at least one completed file.", variant: "destructive" });
      return;
    }
    bulkDownload(ids, {
      onSuccess: (data) => {
        toast({ title: "Bundle ready", description: `Combined ${data.bundledCount} file${data.bundledCount !== 1 ? "s" : ""} into a new archive.` });
        setSelectedIds(new Set());
      },
      onError: (err) => {
        toast({ title: "Download failed", description: err.message, variant: "destructive" });
      },
    });
  };

  const handleArchiveSelected = () => {
    const ids = [...selectedIds].filter(id => conversions?.find(c => c.id === id && c.status === "done"));
    if (ids.length === 0) {
      toast({ title: "Select at least one completed file", variant: "destructive" });
      return;
    }
    startUpload(ids, {
      onError: (err: any) => toast({ title: "Archive.org upload failed", description: err.message, variant: "destructive" }),
    });
  };

  const toggleSelectId = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const togglePlaylistItem = (idx: number) => {
    if (!playlistPreview) return;
    const next = new Set(playlistPreview.selected);
    if (next.has(idx)) next.delete(idx); else next.add(idx);
    setPlaylistPreview({ ...playlistPreview, selected: next });
  };

  const togglePlaylistAll = () => {
    if (!playlistPreview) return;
    const allSelected = playlistPreview.selected.size === playlistPreview.entries.length;
    setPlaylistPreview({
      ...playlistPreview,
      selected: allSelected ? new Set() : new Set(playlistPreview.entries.map((_, i) => i)),
    });
  };

  const confirmPlaylist = () => {
    if (!playlistPreview || playlistPreview.selected.size === 0) return;
    const indices = [...playlistPreview.selected].sort((a, b) => a - b);
    const isAll = indices.length === playlistPreview.entries.length;
    startConversion(playlistPreview.url, isAll ? undefined : indices);
  };

  const activeJobs = conversions?.filter(c =>
    ["pending", "downloading", "converting", "zipping"].includes(c.status)
  ) ?? [];
  const history = conversions?.filter(c =>
    ["done", "error", "cancelled"].includes(c.status)
  ) ?? [];
  const selectableHistoryIds = history.filter(h => ["done", "error", "cancelled"].includes(h.status)).map(h => h.id);
  const selectedDoneCount = [...selectedIds].filter(id => conversions?.find(c => c.id === id && c.status === "done")).length;
  const allHistorySelected = selectableHistoryIds.length > 0 && selectableHistoryIds.every(id => selectedIds.has(id));

  const toggleSelectAll = () => {
    if (allHistorySelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(selectableHistoryIds));
    }
  };

  // Drop selections that no longer exist (after deletes/refresh)
  useEffect(() => {
    if (selectedIds.size === 0 || !conversions) return;
    const valid = new Set(conversions.map(c => c.id));
    const filtered = [...selectedIds].filter(id => valid.has(id));
    if (filtered.length !== selectedIds.size) setSelectedIds(new Set(filtered));
  }, [conversions]);

  const selectClass = "w-full pl-4 pr-10 py-3 rounded-xl bg-background border border-border/80 focus:border-primary focus:ring-2 focus:ring-primary/20 appearance-none font-medium text-sm transition-all";
  const submittedUrlCount = url.split(",").map(value => value.trim()).filter(Boolean).length;

  // Archive upload progress label
  const archiveProgressLabel = isUploading && jobStatus
    ? `${jobStatus.percent}% (${jobStatus.completed}/${jobStatus.total})`
    : isUploading
    ? "Starting..."
    : null;

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-4 py-10">

        {/* Header */}
        <header className="mb-10 text-center relative">
          <button
            type="button"
            onClick={toggleDark}
            title={darkMode ? "Switch to light mode" : "Switch to dark mode"}
            className="absolute right-0 top-0 p-2 rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
          >
            {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
          <div className="inline-flex items-center justify-center p-3 bg-primary/10 text-primary rounded-2xl mb-4">
            <Music className="w-7 h-7" />
          </div>
          <h1 className="text-3xl font-bold text-foreground tracking-tight mb-2">
            MP3 Converter
          </h1>
          <p className="text-muted-foreground text-sm">
            YouTube, SoundCloud, and 1000+ sites. Background processing. Playlist support.
          </p>
        </header>

        {/* Convert form */}
        <div className="bg-card border border-border/60 rounded-2xl p-6 mb-6">
          <form onSubmit={handleSubmit}>
            <div className="flex flex-col sm:flex-row gap-3 mb-4">
              <div className="relative flex-1">
                <div className="absolute inset-y-0 left-3.5 flex items-center pointer-events-none text-muted-foreground">
                  <Link2 className="w-4 h-4" />
                </div>
                <textarea
                  required
                  rows={2}
                  aria-label="URL or comma-separated URLs"
                  autoComplete="off"
                  spellCheck={false}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="Paste one URL, or multiple links separated by commas..."
                  className="w-full pl-10 pr-4 py-3 rounded-xl bg-background border border-border/80 text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all text-sm resize-y min-h-12"
                />
              </div>
              <button
                type="submit"
                disabled={isPending || isChecking || !url.trim()}
                className="w-full sm:w-auto px-6 py-3 rounded-xl font-semibold bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 text-sm flex-shrink-0"
              >
                {(isPending || isChecking) ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                {submittedUrlCount > 1 ? "Convert to ZIP" : "Convert"}
              </button>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 mt-2 text-xs text-muted-foreground">
              <p>Supports YouTube, Internet Archive, SoundCloud, and other yt-dlp sites.</p>
              {submittedUrlCount > 1 && (
                <span className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-1 font-semibold text-primary">
                  {submittedUrlCount} links · ZIP output
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground/70">
              Separate multiple links with commas to process them simultaneously.
            </p>

            {/* Advanced toggle */}
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-0"
            >
              <Settings2 className="w-3.5 h-3.5" />
              {showAdvanced ? "Hide" : "Show"} advanced settings
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showAdvanced ? "rotate-180" : ""}`} />
            </button>

            {showAdvanced && (
              <div className="mt-4 pt-4 border-t border-border/50 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
                <div className="col-span-2 sm:col-span-3 lg:col-span-6">
                  <label className="block text-xs font-semibold text-foreground mb-1.5 flex items-center gap-1.5">
                    <Server className="w-3.5 h-3.5 text-muted-foreground" />
                    Download Server
                  </label>
                  <div className="relative">
                    <select
                      value={downloadServer}
                      onChange={(e) => setDownloadServer(e.target.value)}
                      className={selectClass}
                    >
                      {DOWNLOAD_SERVERS.map(s => (
                        <option key={s.value} value={s.value}>{s.label}</option>
                      ))}
                    </select>
                    <ChevronDown className="w-3.5 h-3.5 absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {downloadServer === "best" && "yt-dlp automatically tries YouTube clients (Android, iOS, Web, etc.) until one works."}
                    {downloadServer === "direct" && "Direct yt-dlp download without any special client override."}
                    {downloadServer === "tv" && "Uses the TV Embedded client. May fail if cookies are stale or invalid."}
                    {downloadServer === "android" && "Uses the Android client."}
                    {downloadServer === "android_testsuite" && "Uses the Android Test Suite client."}
                    {downloadServer === "ios" && "Uses the iOS client."}
                    {downloadServer === "mweb" && "Uses the Mobile Web client."}
                  </p>
                </div>

                {/* Audio Language / Dubbing */}
                <div className="col-span-2 sm:col-span-3 lg:col-span-6">
                  <label className="block text-xs font-semibold text-foreground mb-1.5 flex items-center gap-1.5">
                    <Languages className="w-3.5 h-3.5 text-muted-foreground" />
                    Audio Track / Language
                  </label>
                  <div className="relative">
                    <select
                      value={audioLanguage}
                      onChange={(e) => setAudioLanguage(e.target.value)}
                      className={selectClass}
                    >
                      {AUDIO_LANGUAGES.map(l => (
                        <option key={l.value} value={l.value}>{l.label}</option>
                      ))}
                    </select>
                    <ChevronDown className="w-3.5 h-3.5 absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {audioLanguage === "original"
                      ? "Downloads the default audio track (original language)."
                      : `Selects the dubbed audio track for language code "${audioLanguage}". Falls back to the original track if the dub is unavailable. Works for YouTube dubbed content only.`}
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-foreground mb-1.5">Bitrate</label>
                  <div className="relative">
                    <select value={bitrate} onChange={(e) => setBitrate(Number(e.target.value))} className={selectClass}>
                      <option value={8}>8 kbps</option>
                      <option value={16}>16 kbps</option>
                      <option value={24}>24 kbps</option>
                      <option value={32}>32 kbps</option>
                      <option value={64}>64 kbps</option>
                      <option value={128}>128 kbps</option>
                      <option value={192}>192 kbps</option>
                      <option value={320}>320 kbps</option>
                    </select>
                    <ChevronDown className="w-3.5 h-3.5 absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-foreground mb-1.5">Bitrate Type</label>
                  <div className="relative">
                    <select value={bitrateType} onChange={(e) => setBitrateType(e.target.value as "abr" | "vbr" | "cbr")} className={selectClass}>
                      <option value="abr">ABR (Average)</option>
                      <option value="vbr">VBR (Variable)</option>
                      <option value="cbr">CBR (Constant)</option>
                    </select>
                    <ChevronDown className="w-3.5 h-3.5 absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-foreground mb-1.5">Sample Rate</label>
                  <div className="relative">
                    <select value={sampleRate} onChange={(e) => setSampleRate(Number(e.target.value))} className={selectClass}>
                      <option value={8000}>8000 Hz</option>
                      <option value={11025}>11025 Hz</option>
                      <option value={22050}>22050 Hz</option>
                      <option value={44100}>44100 Hz</option>
                      <option value={48000}>48000 Hz</option>
                    </select>
                    <ChevronDown className="w-3.5 h-3.5 absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-foreground mb-1.5">Channels</label>
                  <div className="relative">
                    <select value={channels} onChange={(e) => setChannels(Number(e.target.value))} className={selectClass}>
                      <option value={1}>Mono</option>
                      <option value={2}>Stereo</option>
                    </select>
                    <ChevronDown className="w-3.5 h-3.5 absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-foreground mb-1.5">Playback Speed</label>
                  <div className="relative">
                    <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className={selectClass}>
                      <option value={1.0}>1.0× (normal)</option>
                      <option value={1.1}>1.1×</option>
                      <option value={1.2}>1.2×</option>
                      <option value={1.25}>1.25×</option>
                      <option value={1.3}>1.3×</option>
                      <option value={1.5}>1.5×</option>
                      <option value={1.75}>1.75×</option>
                      <option value={2.0}>2.0×</option>
                      <option value={2.5}>2.5×</option>
                      <option value={3.0}>3.0×</option>
                    </select>
                    <ChevronDown className="w-3.5 h-3.5 absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                  </div>
                </div>

                {/* Cookies file section */}
                <div className="col-span-2 sm:col-span-3 lg:col-span-6 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-foreground">Cookies File</span>
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <span className="text-xs text-muted-foreground">{cookiesEnabled ? "Enabled" : "Disabled"}</span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={cookiesEnabled}
                        onClick={() => setCookiesEnabled(!cookiesEnabled)}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                          cookiesEnabled ? "bg-primary" : "bg-muted-foreground/30"
                        }`}
                      >
                        <span
                          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                            cookiesEnabled ? "translate-x-4" : "translate-x-1"
                          }`}
                        />
                      </button>
                    </label>
                  </div>
                  <CookiesManager />
                </div>
              </div>
            )}

            <div className="mt-3">
              <ArchiveManager />
            </div>
          </form>
        </div>

        {/* Playlist preview */}
        {playlistPreview && (
          <div className="bg-card border border-primary/40 rounded-2xl p-5 mb-6 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <ListVideo className="w-4 h-4 text-primary" />
                <h3 className="font-semibold text-sm text-foreground">
                  Playlist · {playlistPreview.entries.length} tracks
                </h3>
                <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary text-xs font-bold">
                  {playlistPreview.selected.size} selected
                </span>
              </div>
              <button
                onClick={() => setPlaylistPreview(null)}
                className="text-muted-foreground hover:text-foreground p-1 rounded-md hover:bg-muted transition-colors"
                title="Cancel"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <button
              type="button"
              onClick={togglePlaylistAll}
              className="flex items-center gap-1.5 text-sm font-medium text-primary hover:text-primary/80 mb-3"
            >
              {playlistPreview.selected.size === playlistPreview.entries.length
                ? <><CheckSquare className="w-4 h-4" /> Deselect all</>
                : <><Square className="w-4 h-4" /> Select all</>}
            </button>

            <div className="max-h-72 overflow-y-auto border border-border/50 rounded-lg divide-y divide-border/40">
              {playlistPreview.entries.map((entry, idx) => {
                const checked = playlistPreview.selected.has(idx);
                return (
                  <label
                    key={idx}
                    className="flex items-center gap-3 px-3 py-2 hover:bg-muted/50 cursor-pointer transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => togglePlaylistItem(idx)}
                      className="w-4 h-4 rounded text-primary focus:ring-primary"
                    />
                    <span className="text-xs text-muted-foreground font-mono w-8 flex-shrink-0">
                      {String(idx + 1).padStart(2, "0")}
                    </span>
                    <span className={`text-sm truncate ${checked ? "text-foreground" : "text-muted-foreground"}`}>
                      {entry.title || `Track ${idx + 1}`}
                    </span>
                  </label>
                );
              })}
            </div>

            <div className="flex gap-3 mt-4">
              <button
                onClick={confirmPlaylist}
                disabled={playlistPreview.selected.size === 0 || isPending}
                className="flex-1 px-4 py-2.5 rounded-xl font-semibold bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 text-sm"
              >
                {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                Convert {playlistPreview.selected.size} track{playlistPreview.selected.size !== 1 ? "s" : ""}
              </button>
              <button
                onClick={() => setPlaylistPreview(null)}
                className="px-4 py-2.5 rounded-xl font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Disk space bar */}
        {diskSpace && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-4 px-1">
            <HardDrive className="w-4 h-4" />
            <span>
              <span className="font-medium text-foreground">{formatBytes(diskSpace.freeBytes)}</span> free
              {diskSpace.uploadsDirBytes > 0 && (
                <span className="text-xs ml-1.5">
                  · {formatBytes(diskSpace.uploadsDirBytes)} in converted files
                </span>
              )}
            </span>
          </div>
        )}

        {/* Persistent actions toolbar — visible whenever there's history */}
        {history.length > 0 && (
          <div className="bg-card border border-border/60 rounded-2xl px-4 py-3 mb-6 flex items-center gap-2 flex-wrap">
            {/* Select all toggle */}
            <button
              onClick={toggleSelectAll}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
            >
              {allHistorySelected ? (
                <><CheckCheck className="w-3.5 h-3.5" /> Deselect all</>
              ) : (
                <><CheckSquare className="w-3.5 h-3.5" /> Select all</>
              )}
              {selectableHistoryIds.length > 0 && (
                <span className="ml-1 px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground text-xs font-semibold">
                  {selectedIds.size}/{selectableHistoryIds.length}
                </span>
              )}
            </button>

            <div className="w-px h-5 bg-border/60 mx-1" />

            {/* Download selected */}
            <button
              onClick={handleDownloadSelected}
              disabled={isZipping || selectedDoneCount === 0}
              title={selectedDoneCount === 0 ? "Select completed files first" : `Bundle ${selectedDoneCount} file(s) into a ZIP`}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isZipping ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
              Zip Files
              {selectedDoneCount > 0 && <span className="ml-0.5 text-xs opacity-70">({selectedDoneCount})</span>}
            </button>

            {/* Archive.org */}
            <button
              onClick={handleArchiveSelected}
              disabled={isUploading || selectedDoneCount === 0}
              title={selectedDoneCount === 0 ? "Select completed files first" : `Upload ${selectedDoneCount} file(s) to Archive.org`}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-muted-foreground hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isUploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Archive className="w-3.5 h-3.5" />}
              Archive.org
              {archiveProgressLabel && (
                <span className="ml-0.5 text-xs font-semibold text-amber-600">{archiveProgressLabel}</span>
              )}
              {!archiveProgressLabel && selectedDoneCount > 0 && (
                <span className="ml-0.5 text-xs opacity-70">({selectedDoneCount})</span>
              )}
            </button>

            {/* Delete selected */}
            <button
              onClick={handleDeleteSelected}
              disabled={isDeleting || selectedIds.size === 0}
              title={selectedIds.size === 0 ? "Select files to delete" : "Delete selected files"}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                confirmDelete
                  ? "bg-destructive text-destructive-foreground"
                  : "text-muted-foreground hover:text-destructive hover:bg-destructive/10"
              }`}
            >
              {isDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
              {confirmDelete ? "Confirm delete" : "Delete"}
              {selectedIds.size > 0 && !confirmDelete && (
                <span className="ml-0.5 text-xs opacity-70">({selectedIds.size})</span>
              )}
            </button>
          </div>
        )}

        {/* Content */}
        {isLoading ? (
          <div className="flex justify-center py-16 text-muted-foreground">
            <Loader2 className="w-8 h-8 animate-spin" />
          </div>
        ) : (
          <div className="space-y-8">

            {/* Active jobs */}
            {activeJobs.length > 0 && (
              <section>
                <div className="flex items-center gap-2 mb-3">
                  <ListVideo className="w-4 h-4 text-primary" />
                  <h2 className="text-sm font-semibold text-foreground uppercase tracking-wide">
                    Processing
                  </h2>
                  <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary text-xs font-bold">
                    {activeJobs.length}
                  </span>
                </div>
                <div className="space-y-3">
                  {activeJobs.map(job => (
                    <ConversionCard
                      key={job.id}
                      conversion={job}
                      isDownloaded={downloadedIds.has(job.id)}
                      onDownload={() => markDownloaded(job.id)}
                      onCancel={() => cancelConversion(job.id)}
                      isCancelling={isCancelPending && cancellingId === job.id}
                      onRename={(newTitle) => renameConversion({ id: job.id, title: newTitle })}
                      isRenaming={isRenaming && (renamingId as any)?.id === job.id}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* History */}
            {history.length > 0 && (
              <section>
                <div className="flex items-center gap-2 mb-3">
                  <History className="w-4 h-4 text-muted-foreground" />
                  <h2 className="text-sm font-semibold text-foreground uppercase tracking-wide">
                    History
                  </h2>
                  <span className="px-2 py-0.5 rounded-full bg-muted text-muted-foreground text-xs font-bold">
                    {history.length}
                  </span>
                </div>
                <div className="space-y-3">
                  {history.map(job => (
                    <ConversionCard
                      key={job.id}
                      conversion={job}
                      isDownloaded={downloadedIds.has(job.id)}
                      onDownload={() => markDownloaded(job.id)}
                      selectable
                      selected={selectedIds.has(job.id)}
                      onToggleSelect={() => toggleSelectId(job.id)}
                      onDelete={() => handleDeleteOne(job.id)}
                      isDeleting={isDeletingOne && deletingOneId === job.id}
                      onRename={(newTitle) => renameConversion({ id: job.id, title: newTitle })}
                      isRenaming={isRenaming && (renamingId as any)?.id === job.id}
                    />
                  ))}
                </div>
              </section>
            )}

            {!isLoading && conversions?.length === 0 && (
              <div className="text-center py-16 text-muted-foreground">
                <Music className="w-12 h-12 mx-auto mb-4 opacity-20" />
                <p className="text-sm">No conversions yet. Paste a URL above to get started.</p>
              </div>
            )}
          </div>
        )}

        {/* Footer — Archive.org account link (editable) */}
        <footer className="mt-12 pt-6 border-t border-border/40 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-3 flex-wrap">
            <Archive className="w-3.5 h-3.5 flex-shrink-0" />
            {editingIaUrl ? (
              <form
                className="flex items-center gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  const trimmed = iaUrlDraft.trim();
                  if (trimmed) {
                    setIaAccountUrl(trimmed);
                    localStorage.setItem(IA_ACCOUNT_URL_KEY, trimmed);
                  }
                  setEditingIaUrl(false);
                }}
              >
                <input
                  autoFocus
                  type="url"
                  value={iaUrlDraft}
                  onChange={(e) => setIaUrlDraft(e.target.value)}
                  placeholder="https://archive.org/details/@username"
                  className="w-64 px-2 py-0.5 rounded border border-border bg-background text-xs text-foreground focus:outline-none focus:border-primary"
                />
                <button type="submit" className="text-primary hover:text-primary/80 p-0.5" title="Save">
                  <Check className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setEditingIaUrl(false)}
                  className="hover:text-foreground p-0.5"
                  title="Cancel"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </form>
            ) : (
              <div className="flex items-center gap-1.5">
                <a
                  href={iaAccountUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 hover:text-amber-600 transition-colors"
                >
                  Archive.org Account
                  <ExternalLink className="w-3 h-3" />
                </a>
                <button
                  onClick={() => { setIaUrlDraft(iaAccountUrl); setEditingIaUrl(true); }}
                  className="hover:text-foreground p-0.5 rounded transition-colors"
                  title="Edit Archive.org account link"
                >
                  <Pencil className="w-3 h-3" />
                </button>
              </div>
            )}
            {lastIaUrl && !editingIaUrl && (
              <a
                href={lastIaUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 hover:text-amber-600 transition-colors"
              >
                Last upload ↗
              </a>
            )}
          </div>
          <span className="opacity-50">MP3 Converter · yt-dlp powered</span>
        </footer>

      </div>
    </div>
  );
}
