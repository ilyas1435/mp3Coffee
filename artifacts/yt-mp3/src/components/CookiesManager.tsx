import { useEffect, useState } from "react";
import { Cookie, ChevronDown, Loader2, CheckCircle2, AlertTriangle, Trash2, ExternalLink } from "lucide-react";
import { useCookiesStatus, useUploadCookies, useDeleteCookies } from "@/hooks/use-conversions";
import { useToast } from "@/hooks/use-toast";

interface Props {
  defaultOpen?: boolean;
}

export function CookiesManager({ defaultOpen = false }: Props) {
  const { data: status } = useCookiesStatus();
  const { mutate: upload, isPending: isUploading } = useUploadCookies();
  const { mutate: clear, isPending: isClearing } = useDeleteCookies();
  const { toast } = useToast();
  const [open, setOpen] = useState(defaultOpen);
  const [text, setText] = useState("");

  // Auto-open if a bot-detection error appears later (and the user hasn't interacted).
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);

  const configured = !!status?.configured;

  const handleSave = () => {
    const trimmed = text.trim();
    if (!trimmed) {
      toast({ title: "Paste your cookies first", variant: "destructive" });
      return;
    }
    upload(trimmed, {
      onSuccess: (s) => {
        toast({ title: "Cookies saved", description: `${s.lineCount ?? 0} cookies stored. Conversions will now use them.` });
        setText("");
      },
      onError: (err: any) => {
        toast({ title: "Couldn't save cookies", description: err.message, variant: "destructive" });
      },
    });
  };

  const handleClear = () => {
    clear(undefined, {
      onSuccess: () => toast({ title: "Cookies cleared" }),
      onError: () => toast({ title: "Failed to clear cookies", variant: "destructive" }),
    });
  };

  return (
    <div className="border border-border/40 rounded-xl bg-card/50">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-sm hover:bg-muted/40 transition-colors rounded-xl"
      >
        <div className="flex items-center gap-2 min-w-0">
          <Cookie className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          <span className="font-medium text-foreground">YouTube cookies</span>
          {configured ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-xs font-semibold">
              <CheckCircle2 className="w-3 h-3" />
              Active{status?.lineCount ? ` · ${status.lineCount}` : ""}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-muted text-muted-foreground text-xs font-medium">
              Not configured
            </span>
          )}
        </div>
        <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3 border-t border-border/40">
          <div className="pt-3 text-sm text-muted-foreground space-y-2">
            <p className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-500" />
              <span>
                YouTube videos are now fetched through public Piped instances, which bypasses the
                <strong className="text-foreground"> "Sign in to confirm you're not a bot" </strong>
                error without cookies. Only paste cookies here as a backup if a video fails (e.g.
                age-restricted or member-only content).
              </span>
            </p>
            <p className="text-xs">
              <strong className="text-foreground">How to get cookies:</strong> install the
              {" "}
              <a
                href="https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline inline-flex items-center gap-0.5"
              >
                Get cookies.txt LOCALLY
                <ExternalLink className="w-3 h-3" />
              </a>
              {" "}browser extension, sign in to YouTube in an incognito tab, click the extension, choose "Export As" → Netscape, and paste the file contents below.
            </p>
          </div>

          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="# Netscape HTTP Cookie File&#10;.youtube.com&#9;TRUE&#9;/&#9;TRUE&#9;1234567890&#9;COOKIE_NAME&#9;cookie_value&#10;..."
            spellCheck={false}
            className="w-full min-h-[140px] px-3 py-2 rounded-lg bg-background border border-border/80 focus:border-primary focus:ring-2 focus:ring-primary/20 font-mono text-xs text-foreground placeholder:text-muted-foreground/60 resize-y"
          />

          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={handleSave}
              disabled={isUploading || !text.trim()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isUploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Cookie className="w-3.5 h-3.5" />}
              {configured ? "Replace cookies" : "Save cookies"}
            </button>
            {configured && (
              <button
                type="button"
                onClick={handleClear}
                disabled={isClearing}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-border/60 text-muted-foreground hover:text-destructive hover:border-destructive/40 hover:bg-destructive/5 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isClearing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                Clear
              </button>
            )}
            {status?.updatedAt && (
              <span className="text-xs text-muted-foreground ml-auto">
                Last updated {new Date(status.updatedAt).toLocaleString()}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
