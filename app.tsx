// bb-plugin-kimi — settings UI for the Kimi Code provider.
//
// One settings section that answers the only questions worth asking here: is
// acp-kimi registered, can each machine actually start the CLI, and what does
// it offer? Registration and login are one click each.

import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";

interface KimiModel {
  id: string;
  displayName: string;
  isDefault: boolean;
  reasoningEfforts: string[];
}

interface KimiHost {
  hostId: string;
  hostName: string;
  status: string;
  available: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  models: KimiModel[];
  reasoningLevels: string[];
  offersReasoningChoice: boolean;
}

interface KimiStatus {
  managed: boolean;
  registered: boolean;
  providerId: string;
  command: string;
  displayName: string;
  configPath: string;
  entry: Record<string, unknown> | null;
  hosts: KimiHost[];
  warning: string | null;
}

function StatusDot({ tone }: { tone: "ok" | "warn" | "error" }) {
  const color =
    tone === "ok" ? "bg-primary" : tone === "warn" ? "bg-muted-foreground" : "bg-destructive";
  return <span className={`inline-block size-2 shrink-0 rounded-full ${color}`} aria-hidden />;
}

function HostRow({ host, onLogin }: { host: KimiHost; onLogin: (hostId: string) => void }) {
  const tone = host.available ? "ok" : host.errorCode === "host_offline" ? "warn" : "error";
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <StatusDot tone={tone} />
          <span>{host.hostName}</span>
        </div>
        {host.errorCode === "auth_required" ? (
          <Button size="sm" variant="outline" onClick={() => onLogin(host.hostId)}>
            Sign in
          </Button>
        ) : null}
      </div>
      {host.available ? (
        <>
          <ul className="mt-2 space-y-1">
            {host.models.map((model) => (
              <li key={model.id} className="flex items-baseline gap-2 text-sm">
                <code className="text-xs text-muted-foreground">{model.id}</code>
                <span>{model.displayName}</span>
                {model.isDefault ? (
                  <span className="text-xs text-muted-foreground">default</span>
                ) : null}
                {model.reasoningEfforts.length > 1 ? (
                  <span className="ml-auto text-xs text-muted-foreground">
                    {model.reasoningEfforts.join(" · ")}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {host.offersReasoningChoice ? null : (
            <p className="mt-2 text-sm text-muted-foreground">
              No selectable reasoning levels — this machine's Kimi Code CLI is likely
              outdated. Upgrade it with{" "}
              <code className="text-xs">
                curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
              </code>
              .
            </p>
          )}
        </>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          {host.errorMessage ?? "Unavailable."}
        </p>
      )}
    </div>
  );
}

function KimiSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<KimiStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus((await rpc.call("status")) as KimiStatus);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [rpc]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sync = async () => {
    setBusy(true);
    try {
      const result = await rpc.call("sync");
      setStatus(result.status as KimiStatus);
      toast.success(
        result.changed ? "Registered the Kimi Code provider." : "Provider already up to date.",
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const login = async (hostId?: string) => {
    setBusy(true);
    try {
      const result = await rpc.call("login", hostId === undefined ? {} : { hostId });
      toast.success(`Opened a login terminal on ${result.hostName}.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (loadError !== null) {
    return <p className="text-sm text-destructive">{loadError}</p>;
  }
  if (status === null) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-sm">
          <StatusDot tone={status.registered ? "ok" : "error"} />
          <span>
            {status.registered ? "Registered as " : "Not registered — "}
            <code className="text-xs">{status.providerId}</code>
          </span>
        </div>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void sync()}>
            {status.registered ? "Re-sync" : "Register"}
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void login()}>
            Sign in
          </Button>
        </div>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Command</dt>
        <dd>
          <code className="text-xs">{status.command} acp</code>
        </dd>
        <dt className="text-muted-foreground">Config</dt>
        <dd>
          <code className="text-xs break-all">{status.configPath}</code>
        </dd>
      </dl>

      {status.warning !== null ? (
        <p className="rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground">
          {status.warning}
        </p>
      ) : null}

      {status.hosts.length > 0 ? (
        <div className="space-y-2">
          <h4 className="text-sm font-medium">Machines</h4>
          {status.hosts.map((host) => (
            <HostRow key={host.hostId} host={host} onLogin={(id) => void login(id)} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "kimi-provider",
    title: "Kimi Code provider",
    description:
      "Registers Kimi Code with BB as acp-kimi over the Agent Client Protocol, then reports whether each machine can start it.",
    component: KimiSettings,
  });
});
