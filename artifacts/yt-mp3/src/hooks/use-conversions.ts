import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { useState, useCallback } from "react";
import type { Conversion, CreateConversionRequest, ErrorResponse } from "@workspace/api-client-react";

export function useConversions() {
  return useQuery({
    queryKey: ["conversions"],
    queryFn: async () => {
      const res = await fetch("/api/conversions");
      if (!res.ok) throw new Error("Failed to fetch conversions");
      return (await res.json()) as Conversion[];
    },
    refetchInterval: (query) => {
      const data = query.state.data;
      const hasActive = data?.some(c =>
        ["pending", "downloading", "converting", "zipping"].includes(c.status)
      );
      return hasActive ? 3000 : false;
    },
    staleTime: 3_000,
    // Keep showing previous data while a background refetch is in-flight so the
    // list never disappears or flickers (which looks like a page refresh to users).
    placeholderData: keepPreviousData,
  });
}

export function useCreateConversion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: CreateConversionRequest & { downloadServer?: string; audioLanguage?: string }) => {
      const res = await fetch("/api/conversions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      if (!res.ok) {
        let errMessage = "Failed to create conversion";
        try {
          const errorData = (await res.json()) as ErrorResponse;
          errMessage = errorData.error || errMessage;
        } catch {}
        throw new Error(errMessage);
      }

      return (await res.json()) as Conversion;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversions"] });
      queryClient.invalidateQueries({ queryKey: ["disk-space"] });
    },
  });
}

export function useCancelConversion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/conversions/${id}/cancel`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to cancel");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversions"] });
    },
  });
}

export function usePlaylistInfo() {
  return useMutation({
    mutationFn: async (url: string) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20_000); // 20s client timeout
      try {
        const res = await fetch(`/api/playlist-info?url=${encodeURIComponent(url)}`, { signal: ctrl.signal });
        if (!res.ok) throw new Error("Failed to check URL");
        return (await res.json()) as {
          isPlaylist: boolean;
          entries: { id: string; title: string; url: string }[];
          name?: string | null;
        };
      } finally {
        clearTimeout(timer);
      }
    },
  });
}

export function useBulkDownload() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (ids: number[]) => {
      const res = await fetch("/api/conversions/bulk-download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) {
        let msg = "Failed to bundle";
        try { const j = (await res.json()) as ErrorResponse; msg = j.error || msg; } catch {}
        throw new Error(msg);
      }
      return (await res.json()) as { bundle: Conversion; bundledCount: number };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversions"] });
      queryClient.invalidateQueries({ queryKey: ["disk-space"] });
    },
  });
}

export function useDeleteConversion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/conversions/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversions"] });
      queryClient.invalidateQueries({ queryKey: ["disk-space"] });
    },
  });
}

export function useRenameConversion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, title }: { id: number; title: string }) => {
      const res = await fetch(`/api/conversions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) throw new Error("Failed to rename");
      return (await res.json()) as Conversion;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversions"] });
    },
  });
}

export function useDeleteAllConversions() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (ids?: number[]) => {
      const res = await fetch("/api/conversions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ids ?? [] }),
      });
      if (!res.ok) throw new Error("Failed to delete");
      return (await res.json()) as { deleted: number };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversions"] });
      queryClient.invalidateQueries({ queryKey: ["disk-space"] });
    },
  });
}

export interface CookiesStatus {
  configured: boolean;
  sizeBytes?: number;
  lineCount?: number;
  updatedAt?: string;
}

export function useCookiesStatus() {
  return useQuery({
    queryKey: ["cookies-status"],
    queryFn: async () => {
      const res = await fetch("/api/cookies");
      if (!res.ok) throw new Error("Failed to fetch cookies status");
      return (await res.json()) as CookiesStatus;
    },
  });
}

export function useUploadCookies() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (cookies: string) => {
      const res = await fetch("/api/cookies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cookies }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed to save cookies");
      return data as CookiesStatus;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cookies-status"] });
    },
  });
}

export function useDeleteCookies() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/cookies", { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to clear cookies");
      return (await res.json()) as CookiesStatus;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cookies-status"] });
    },
  });
}

export interface IACredentialsStatus {
  configured: boolean;
}

export function useIACredentials() {
  return useQuery({
    queryKey: ["ia-credentials"],
    queryFn: async () => {
      const res = await fetch("/api/archive/credentials");
      if (!res.ok) throw new Error("Failed to fetch IA credentials");
      return (await res.json()) as IACredentialsStatus;
    },
  });
}

export function useSaveIACredentials() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ access, secret }: { access: string; secret: string }) => {
      const res = await fetch("/api/archive/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access, secret }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed to save credentials");
      return data as IACredentialsStatus;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ia-credentials"] }),
  });
}

export function useDeleteIACredentials() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/archive/credentials", { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to clear credentials");
      return (await res.json()) as IACredentialsStatus;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ia-credentials"] }),
  });
}

// ─── Archive Upload (background job with progress polling) ────────────────────

export interface ArchiveJobStatus {
  status: "uploading" | "done" | "error";
  total: number;
  completed: number;
  failed: number;
  percent: number;
  results: Array<{ id: number; title: string; url: string; error?: string }>;
  iaPageUrl: string;
  identifier: string;
  error?: string;
}

export interface ArchiveUploadStart {
  jobId: string;
  iaPageUrl: string;
  identifier: string;
  total: number;
}

export function useArchiveUpload() {
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  const startMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      const res = await fetch("/api/archive/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Upload failed");
      return data as ArchiveUploadStart;
    },
    onSuccess: (data) => {
      setActiveJobId(data.jobId);
    },
  });

  const { data: jobStatus } = useQuery({
    queryKey: ["archive-job", activeJobId],
    queryFn: async () => {
      const res = await fetch(`/api/archive/status/${activeJobId}`);
      if (!res.ok) throw new Error("Failed to get upload status");
      return (await res.json()) as ArchiveJobStatus;
    },
    enabled: !!activeJobId,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data || data.status === "uploading") return 1000;
      return false;
    },
  });

  const clearJob = useCallback(() => setActiveJobId(null), []);

  const isUploading = startMutation.isPending || (!!activeJobId && jobStatus?.status === "uploading");

  return {
    startUpload: startMutation.mutate,
    isPending: startMutation.isPending,
    isUploading,
    activeJobId,
    jobStatus,
    clearJob,
  };
}

export function useDiskSpace() {
  return useQuery({
    queryKey: ["disk-space"],
    queryFn: async () => {
      const res = await fetch("/api/disk-space");
      if (!res.ok) throw new Error("Failed to fetch disk space");
      return (await res.json()) as {
        freeBytes: number;
        totalBytes: number;
        usedBytes: number;
        uploadsDirBytes: number;
      };
    },
    refetchInterval: 30_000,
  });
}

export interface AppSettings {
  bitrate?: number;
  bitrateType?: string;
  sampleRate?: number;
  channels?: number;
  speed?: number;
  downloadServer?: string;
  cookiesEnabled?: boolean;
  audioLanguage?: string;
}

export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const res = await fetch("/api/settings");
      if (!res.ok) throw new Error("Failed to fetch settings");
      return (await res.json()) as AppSettings;
    },
    staleTime: 60_000,
  });
}

export function useSaveSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (settings: Partial<AppSettings>) => {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (!res.ok) throw new Error("Failed to save settings");
      return (await res.json()) as AppSettings;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["settings"], data);
    },
  });
}
