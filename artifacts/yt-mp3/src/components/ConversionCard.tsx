import { useRef, useState } from "react";
import type { Conversion } from "@workspace/api-client-react";
import { FileAudio, Download, AlertCircle, CheckCircle2, Loader2, Activity, HardDrive, Archive, ListMusic, CheckCheck, X, Ban, Trash2, Pencil, Check } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

interface ConversionCardProps {
  conversion: Conversion;
  isDownloaded?: boolean;
  onDownload?: () => void;
  onCancel?: () => void;
  isCancelling?: boolean;
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  onDelete?: () => void;
  isDeleting?: boolean;
  onRename?: (newTitle: string) => void;
  isRenaming?: boolean;
}

export function ConversionCard({
  conversion, isDownloaded = false, onDownload, onCancel, isCancelling = false,
  selectable = false, selected = false, onToggleSelect, onDelete, isDeleting = false,
  onRename, isRenaming = false,
}: ConversionCardProps) {
  const isActive = ["pending", "downloading", "converting", "zipping"].includes(conversion.status);
  const isDone = conversion.status === "done";
  const isError = conversion.status === "error";
  const isCancelled = conversion.status === "cancelled";

  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const displayTitle = conversion.title || conversion.youtubeUrl;

  const startEditing = () => {
    setEditValue(conversion.title || "");
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  };

  const commitEdit = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== conversion.title && onRename) {
      onRename(trimmed);
    }
    setEditing(false);
  };

  const cancelEdit = () => setEditing(false);

  function formatBytes(bytes: number | null | undefined) {
    if (!bytes) return "--";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  const bitrateLabel = conversion.bitrateType?.toUpperCase() ?? "ABR";
  const channelLabel = conversion.channels === 1 ? "Mono" : "Stereo";

  const cardClass = (isDone && isDownloaded) || isCancelled
    ? "bg-card rounded-2xl p-5 border border-border/40 opacity-70"
    : "bg-card rounded-2xl p-5 border border-border/60";

  const iconBg = isDone
    ? isDownloaded
      ? "bg-muted text-muted-foreground"
      : "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400"
    : isError
    ? "bg-destructive/10 text-destructive"
    : isCancelled
    ? "bg-muted text-muted-foreground"
    : "bg-primary/10 text-primary";

  const titleClass = (isDone && isDownloaded) || isCancelled
    ? "text-base font-semibold text-muted-foreground"
    : "text-base font-semibold text-foreground";

  const showCheckbox = selectable && (isDone || isError || isCancelled);
  // Allow rename while active (to pre-set the output filename) or when done
  const canRename = (isDone || isActive) && !!onRename;

  return (
    <div className={cardClass}>
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">

        <div className="flex items-start gap-4 flex-1 min-w-0">
          {showCheckbox && (
            <label className="flex items-center justify-center pt-3 cursor-pointer flex-shrink-0" title={selected ? "Deselect" : "Select"}>
              <input
                type="checkbox"
                checked={selected}
                onChange={onToggleSelect}
                className="w-5 h-5 rounded-md border-2 border-border accent-primary cursor-pointer"
              />
            </label>
          )}
          <div className={`p-3 rounded-xl flex-shrink-0 ${iconBg}`}>
            {isDone
              ? (isDownloaded
                  ? <CheckCheck className="w-6 h-6" />
                  : conversion.isPlaylist
                  ? <Archive className="w-6 h-6" />
                  : <CheckCircle2 className="w-6 h-6" />)
              : isError
              ? <AlertCircle className="w-6 h-6" />
              : isCancelled
              ? <Ban className="w-6 h-6" />
              : <Loader2 className="w-6 h-6 animate-spin" />}
          </div>

          <div className="flex-1 min-w-0 pt-0.5">
            <div className="flex items-center gap-2 flex-wrap">
              {editing ? (
                <div className="flex items-center gap-1.5 flex-1 min-w-0">
                  <input
                    ref={inputRef}
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEdit();
                      if (e.key === "Escape") cancelEdit();
                    }}
                    onBlur={commitEdit}
                    autoFocus
                    className="flex-1 min-w-0 px-2 py-0.5 text-base font-semibold rounded-md bg-background border border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 text-foreground"
                  />
                  <button onClick={commitEdit} disabled={isRenaming} title="Save" className="text-primary hover:text-primary/80 flex-shrink-0">
                    {isRenaming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  </button>
                  <button onClick={cancelEdit} title="Cancel" className="text-muted-foreground hover:text-foreground flex-shrink-0">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 min-w-0">
                  <h3 className={`${titleClass} truncate`} title={displayTitle}>
                    {displayTitle}
                  </h3>
                  {canRename && !isRenaming && (
                    <button
                      onClick={startEditing}
                      title="Rename file"
                      className="flex-shrink-0 p-0.5 rounded text-muted-foreground/60 hover:text-primary transition-colors"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {isRenaming && <Loader2 className="w-3.5 h-3.5 animate-spin text-primary flex-shrink-0" />}
                </div>
              )}

              {conversion.isPlaylist && !editing && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex-shrink-0">
                  <ListMusic className="w-3 h-3" />
                  Playlist{conversion.itemCount ? ` · ${conversion.itemCount}` : ""}
                </span>
              )}
              {isDone && isDownloaded && !editing && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-muted text-muted-foreground text-xs font-medium flex-shrink-0">
                  Downloaded
                </span>
              )}
              {isCancelled && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-muted text-muted-foreground text-xs font-medium flex-shrink-0">
                  Cancelled
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mt-2 text-sm text-muted-foreground">
              <span className="flex items-center gap-1.5" title="Bitrate">
                <FileAudio className="w-3.5 h-3.5" />
                {conversion.bitrate} kbps ({bitrateLabel})
              </span>
              <span className="flex items-center gap-1.5" title="Sample Rate">
                {conversion.sampleRate} Hz
              </span>
              <span className="flex items-center gap-1.5" title="Channels">
                <Activity className="w-3.5 h-3.5" />
                {channelLabel}
              </span>
              {isDone && conversion.fileSizeBytes != null && (
                <span className="flex items-center gap-1.5 font-medium text-foreground/70" title="File Size">
                  <HardDrive className="w-3.5 h-3.5" />
                  {formatBytes(conversion.fileSizeBytes)}
                </span>
              )}
              <span className="text-xs text-muted-foreground/60">
                {formatDistanceToNow(new Date(conversion.createdAt), { addSuffix: true })}
              </span>
            </div>
          </div>
        </div>

        <div className="flex gap-1.5 flex-shrink-0 w-full sm:w-auto">
          {isDone && (
            <a
              href={`/api/conversions/${conversion.id}/download`}
              download
              onClick={onDownload}
              title={isDownloaded ? "Download again" : conversion.isPlaylist ? "Download ZIP" : "Download MP3"}
              className={`flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
                isDownloaded
                  ? "bg-muted text-muted-foreground hover:bg-muted/80 border border-border/60"
                  : "bg-primary text-primary-foreground hover:bg-primary/90"
              }`}
            >
              <Download className="w-3.5 h-3.5" />
              {conversion.isPlaylist ? "ZIP" : "MP3"}
            </a>
          )}

          {isActive && onCancel && (
            <button
              onClick={onCancel}
              disabled={isCancelling}
              title="Cancel conversion"
              className="flex-shrink-0 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-border/60 text-muted-foreground hover:text-destructive hover:border-destructive/40 hover:bg-destructive/5 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isCancelling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
              Cancel
            </button>
          )}

          {!isActive && onDelete && (
            <button
              onClick={onDelete}
              disabled={isDeleting}
              title="Delete this file"
              aria-label="Delete"
              className="flex-shrink-0 inline-flex items-center justify-center px-2 py-1.5 rounded-lg border border-border/60 text-muted-foreground hover:text-destructive hover:border-destructive/40 hover:bg-destructive/5 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>
      </div>

      {isActive && (
        <div className="mt-5">
          <div className="flex justify-between items-end mb-2">
            <span className="text-sm font-medium text-foreground">
              {conversion.statusLabel || "Processing..."}
            </span>
            <span className="text-sm font-bold text-primary tabular-nums">
              {Math.round(conversion.progress ?? 0)}%
            </span>
          </div>
          <div className="h-2 w-full bg-secondary rounded-full overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-500 ease-out"
              style={{ width: `${Math.max(conversion.progress ?? 0, 1)}%` }}
            />
          </div>
        </div>
      )}

      {isError && (
        <div className="mt-4 p-4 bg-destructive/5 text-destructive text-sm rounded-xl border border-destructive/20">
          <p className="font-semibold flex items-center gap-2">
            <AlertCircle className="w-4 h-4" /> Failed
          </p>
          <p className="mt-1 opacity-80 pl-6">{conversion.error || "An unknown error occurred."}</p>
        </div>
      )}
    </div>
  );
}
