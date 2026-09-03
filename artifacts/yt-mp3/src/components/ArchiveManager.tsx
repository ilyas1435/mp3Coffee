import { useEffect, useState } from "react";
import { Archive, ChevronDown, Loader2, CheckCircle2, Trash2, ExternalLink, Key } from "lucide-react";
import { useIACredentials, useSaveIACredentials, useDeleteIACredentials } from "@/hooks/use-conversions";
import { useToast } from "@/hooks/use-toast";

export function ArchiveManager() {
  const { data: status } = useIACredentials();
  const { mutate: save, isPending: isSaving } = useSaveIACredentials();
  const { mutate: clear, isPending: isClearing } = useDeleteIACredentials();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [access, setAccess] = useState("");
  const [secret, setSecret] = useState("");

  const configured = !!status?.configured;

  const handleSave = () => {
    if (!access.trim() || !secret.trim()) {
      toast({ title: "Enter both Access Key and Secret Key", variant: "destructive" });
      return;
    }
    save({ access: access.trim(), secret: secret.trim() }, {
      onSuccess: () => {
        toast({ title: "Archive.org credentials saved" });
        setAccess("");
        setSecret("");
      },
      onError: (err: any) => toast({ title: "Failed to save credentials", description: err.message, variant: "destructive" }),
    });
  };

  const handleClear = () => {
    clear(undefined, {
      onSuccess: () => toast({ title: "Archive.org credentials cleared" }),
      onError: () => toast({ title: "Failed to clear credentials", variant: "destructive" }),
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
          <Archive className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          <span className="font-medium text-foreground">Archive.org backup</span>
          {configured ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-xs font-semibold">
              <CheckCircle2 className="w-3 h-3" />
              Configured
            </span>
          ) : (
            <span className="px-2 py-0.5 rounded-full bg-muted text-muted-foreground text-xs font-medium">
              Not configured
            </span>
          )}
        </div>
        <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform flex-shrink-0 ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3 border-t border-border/40">
          <div className="pt-3 text-sm text-muted-foreground space-y-2">
            <p>
              Upload converted files to{" "}
              <a href="https://archive.org" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-0.5">
                Internet Archive <ExternalLink className="w-3 h-3" />
              </a>{" "}
              for permanent free storage. You need a free account and S3-like API keys.
            </p>
            <p className="text-xs">
              Get your keys at{" "}
              <a href="https://archive.org/account/s3.php" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-0.5">
                archive.org/account/s3.php <ExternalLink className="w-3 h-3" />
              </a>
              . Keys are stored locally on this server only.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-semibold text-foreground mb-1">Access Key</label>
              <input
                type="text"
                value={access}
                onChange={(e) => setAccess(e.target.value)}
                placeholder="your-access-key"
                autoComplete="off"
                className="w-full px-3 py-2 rounded-lg bg-background border border-border/80 focus:border-primary focus:ring-2 focus:ring-primary/20 text-xs text-foreground placeholder:text-muted-foreground/60"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-foreground mb-1">Secret Key</label>
              <input
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder="your-secret-key"
                autoComplete="new-password"
                className="w-full px-3 py-2 rounded-lg bg-background border border-border/80 focus:border-primary focus:ring-2 focus:ring-primary/20 text-xs text-foreground placeholder:text-muted-foreground/60"
              />
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving || (!access.trim() && !secret.trim())}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Key className="w-3.5 h-3.5" />}
              {configured ? "Update keys" : "Save keys"}
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
          </div>
        </div>
      )}
    </div>
  );
}
