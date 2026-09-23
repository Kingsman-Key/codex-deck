import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CcSwitchImportResult,
  CcSwitchScanResult,
  ProfileInput,
  ProfileView,
  ProviderKind,
  SystemStatus,
} from "./shared/types";

const COLORS = ["#7CFFB2", "#A8C7FA", "#C4A7FF", "#FFB86B", "#FF8C9B"];

const PROVIDER_META: Record<ProviderKind, { label: string; short: string }> = {
  chatgpt: { label: "ChatGPT 账号", short: "OA" },
  "openrouter-deepseek": { label: "DeepSeek · OpenRouter", short: "DS" },
  custom: { label: "自定义 Responses", short: "API" },
};

function App() {
  const [profiles, setProfiles] = useState<ProfileView[]>([]);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [ccSwitchScan, setCcSwitchScan] = useState<CcSwitchScanResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editor, setEditor] = useState<ProfileView | "new" | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showCcSwitchImport, setShowCcSwitchImport] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [nextProfiles, nextStatus, nextCcSwitchScan] = await Promise.all([
      window.codexDeck.listProfiles(),
      window.codexDeck.getSystemStatus(),
      window.codexDeck.scanCcSwitch(),
    ]);
    setProfiles(nextProfiles);
    setStatus(nextStatus);
    setCcSwitchScan(nextCcSwitchScan);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh().catch((error) => {
      setToast(cleanError(error));
      setLoading(false);
    });
    return window.codexDeck.onProfilesChanged(() => void refresh());
  }, [refresh]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key < "1" || event.key > "9") {
        return;
      }
      const profile = profiles[Number(event.key) - 1];
      if (profile) void launch(profile);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const runningCount = useMemo(
    () => profiles.filter((profile) => profile.running).length,
    [profiles],
  );
  const ccSwitchReadyCount = useMemo(
    () =>
      ccSwitchScan?.candidates.filter(
        (candidate) => candidate.compatible && !candidate.alreadyImported,
      ).length ?? 0,
    [ccSwitchScan],
  );

  async function launch(profile: ProfileView) {
    setBusyId(profile.id);
    try {
      const result = await window.codexDeck.launchProfile(profile.id);
      setToast(
        result.status === "focused"
          ? `已切到「${profile.name}」`
          : `「${profile.name}」正在启动`,
      );
      await refresh();
    } catch (error) {
      setToast(cleanError(error));
    } finally {
      setBusyId(null);
    }
  }

  async function quit(profile: ProfileView) {
    setBusyId(profile.id);
    try {
      await window.codexDeck.quitProfile(profile.id);
      setToast(`已退出「${profile.name}」`);
      await refresh();
    } catch (error) {
      setToast(cleanError(error));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(profile: ProfileView) {
    const confirmed = window.confirm(
      `移除「${profile.name}」？配置数据会进入系统废纸篓，可以恢复。`,
    );
    if (!confirmed) return;
    try {
      await window.codexDeck.deleteProfile(profile.id);
      setToast(`已移除「${profile.name}」`);
      await refresh();
    } catch (error) {
      setToast(cleanError(error));
    }
  }

  async function chooseExecutable() {
    try {
      const selected = await window.codexDeck.chooseExecutable();
      if (selected) {
        setToast("已更新桌面应用路径");
        await refresh();
      }
    } catch (error) {
      setToast(cleanError(error));
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div>
            <h1>Codex Deck</h1>
            <p>多实例工作台</p>
          </div>
        </div>

        <div className="top-actions">
          <div className="run-summary">
            <span className={runningCount ? "status-dot live" : "status-dot"} />
            {runningCount ? `${runningCount} 个窗口运行中` : "暂无运行窗口"}
          </div>
          <button
            className="icon-button"
            onClick={() => setShowSettings((value) => !value)}
            aria-label="设置"
            title="设置"
          >
            <GearIcon />
          </button>
          <button className="primary-button" onClick={() => setEditor("new")}>
            <PlusIcon />
            添加配置
          </button>
        </div>
      </header>

      {showSettings && (
        <section className="settings-panel">
          <div>
            <span className="eyebrow">桌面程序</span>
            <strong>{status?.desktopExecutable ? "已连接" : "未找到"}</strong>
            <p title={status?.desktopExecutable ?? undefined}>
              {status?.desktopExecutable ?? "请选择 Codex / ChatGPT 可执行文件"}
            </p>
          </div>
          <div className="settings-actions">
            {ccSwitchScan?.found && (
              <button
                className="text-button import-button"
                onClick={() => setShowCcSwitchImport(true)}
              >
                导入 CC Switch{ccSwitchReadyCount ? ` (${ccSwitchReadyCount})` : ""}
              </button>
            )}
            <button className="text-button" onClick={() => void chooseExecutable()}>
              选择程序
            </button>
            <button
              className="text-button"
              onClick={() => void window.codexDeck.openDataFolder()}
            >
              打开数据目录
            </button>
          </div>
        </section>
      )}

      <section className="hero">
        <div>
          <span className="eyebrow">ONE CLICK · ZERO SIGN-OUT</span>
          <h2>点一下，就进入正确的 Codex。</h2>
          <p>
            每个配置拥有独立登录态、会话数据和模型设置。窗口可以同时运行，不再退出、覆盖
            <code> auth.json </code>或来回改配置。
          </p>
        </div>
        <div className="hero-stat">
          <strong>{profiles.length.toString().padStart(2, "0")}</strong>
          <span>个独立配置</span>
        </div>
      </section>

      {ccSwitchScan?.found && ccSwitchReadyCount > 0 && (
        <section className="cc-import-banner">
          <div className="cc-import-symbol">CC</div>
          <div>
            <span className="eyebrow">自动发现</span>
            <strong>找到 {ccSwitchReadyCount} 个可导入的 CC Switch 配置</strong>
            <p>只读扫描；导入是本地复制，不会修改 CC Switch 原数据库。</p>
          </div>
          <button className="secondary-button" onClick={() => setShowCcSwitchImport(true)}>
            查看并导入
          </button>
        </section>
      )}

      <section className="profile-section">
        <div className="section-heading">
          <div>
            <span className="eyebrow">配置总览</span>
            <h3>你的 Codex 窗口</h3>
          </div>
          <span className="shortcut-hint">⌘ / Ctrl + 1–9 快速打开</span>
        </div>

        {loading ? (
          <div className="empty-state">正在读取本地配置…</div>
        ) : profiles.length === 0 ? (
          <button className="empty-state empty-action" onClick={() => setEditor("new")}>
            <span className="empty-plus">+</span>
            <strong>创建第一个独立窗口</strong>
            <span>ChatGPT 账号或 DeepSeek 都可以；首次只需登录或填一次 Key。</span>
          </button>
        ) : (
          <div className="profile-grid">
            {profiles.map((profile, index) => (
              <article
                key={profile.id}
                className={`profile-card ${profile.running ? "is-running" : ""}`}
                style={{ "--accent": profile.color } as React.CSSProperties}
                onClick={() => void launch(profile)}
              >
                <div className="card-stripe" />
                <div className="card-head">
                  <div className="provider-avatar">
                    {PROVIDER_META[profile.provider].short}
                  </div>
                  <div className="card-controls" onClick={(event) => event.stopPropagation()}>
                    {profile.running && (
                      <button
                        className="card-icon-button"
                        onClick={() => void quit(profile)}
                        title="退出此窗口"
                        aria-label="退出此窗口"
                      >
                        <StopIcon />
                      </button>
                    )}
                    <button
                      className="card-icon-button"
                      onClick={() => setEditor(profile)}
                      title="编辑"
                      aria-label="编辑"
                    >
                      <EditIcon />
                    </button>
                    <button
                      className="card-icon-button danger"
                      onClick={() => void remove(profile)}
                      title="移除"
                      aria-label="移除"
                    >
                      <TrashIcon />
                    </button>
                  </div>
                </div>

                <div className="card-body">
                  <div className="profile-state">
                    <span className={profile.running ? "status-dot live" : "status-dot"} />
                    {profile.running ? "运行中 · 点击切换" : "点击启动"}
                  </div>
                  <h4>{profile.name}</h4>
                  <p>
                    {PROVIDER_META[profile.provider].label}
                    {profile.importedFrom?.kind === "cc-switch" && (
                      <span className="imported-badge">CC Switch</span>
                    )}
                  </p>
                  {profile.model && <code className="model-name">{profile.model}</code>}
                </div>

                <div className="card-footer">
                  <span>0{index + 1}</span>
                  <span className="launch-label">
                    {busyId === profile.id
                      ? "处理中…"
                      : profile.running
                        ? "切换窗口 ↗"
                        : "打开窗口 →"}
                  </span>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <footer>
        <span>本地运行 · 登录态不上传</span>
        <span>
          {status?.encryptionAvailable ? "API Key 受系统安全存储保护" : "系统安全存储不可用"}
        </span>
      </footer>

      {editor && (
        <ProfileEditor
          profile={editor === "new" ? null : editor}
          onClose={() => setEditor(null)}
          onSaved={async (message) => {
            setEditor(null);
            setToast(message);
            await refresh();
          }}
        />
      )}

      {showCcSwitchImport && ccSwitchScan && (
        <CcSwitchImportDialog
          scan={ccSwitchScan}
          onClose={() => setShowCcSwitchImport(false)}
          onImported={async (result) => {
            setShowCcSwitchImport(false);
            const suffix = result.skipped.length
              ? `，${result.skipped.length} 个跳过`
              : "";
            setToast(`已导入 ${result.imported.length} 个 CC Switch 配置${suffix}`);
            await refresh();
          }}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}

function ProfileEditor({
  profile,
  onClose,
  onSaved,
}: {
  profile: ProfileView | null;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const [provider, setProvider] = useState<ProviderKind>(profile?.provider ?? "chatgpt");
  const [name, setName] = useState(profile?.name ?? "");
  const [color, setColor] = useState(profile?.color ?? COLORS[0]);
  const [model, setModel] = useState(
    profile?.model ?? "deepseek/deepseek-v4.1-flash",
  );
  const [baseUrl, setBaseUrl] = useState(profile?.baseUrl ?? "https://api.example.com/v1");
  const [apiKey, setApiKey] = useState("");
  const [importCurrentSession, setImportCurrentSession] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const preservesImportedOAuth = Boolean(
        profile?.configurationSource === "cc-switch" &&
          profile.credentialKind === "oauth" &&
          provider === profile.provider &&
          (provider === "chatgpt" ||
            (baseUrl === profile.baseUrl && model === profile.model)),
      );
      if (
        provider !== "chatgpt" &&
        !preservesImportedOAuth &&
        !apiKey &&
        !profile?.hasApiKey
      ) {
        throw new Error("请填写 API Key。");
      }
      const input: ProfileInput = {
        id: profile?.id,
        name,
        color,
        provider,
        model: provider === "chatgpt" ? undefined : model,
        baseUrl:
          provider === "openrouter-deepseek"
            ? "https://openrouter.ai/api/v1"
            : provider === "custom"
              ? baseUrl
              : undefined,
        apiKey: apiKey || undefined,
        importCurrentSession: !profile && provider === "chatgpt" && importCurrentSession,
      };
      await window.codexDeck.saveProfile(input);
      await onSaved(profile ? `已更新「${name.trim()}」` : `已创建「${name.trim()}」`);
    } catch (submitError) {
      setError(cleanError(submitError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal"
        onSubmit={(event) => void submit(event)}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <span className="eyebrow">{profile ? "EDIT PROFILE" : "NEW PROFILE"}</span>
            <h3>{profile ? "编辑配置" : "添加独立 Codex"}</h3>
          </div>
          <button type="button" className="close-button" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <label className="field">
          <span>名称</span>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：工作账号 / DeepSeek"
            maxLength={40}
          />
        </label>

        <fieldset className="provider-picker">
          <legend>连接方式</legend>
          {(Object.keys(PROVIDER_META) as ProviderKind[]).map((kind) => (
            <button
              type="button"
              key={kind}
              className={provider === kind ? "selected" : ""}
              onClick={() => {
                setProvider(kind);
                if (kind === "openrouter-deepseek") {
                  setModel("deepseek/deepseek-v4.1-flash");
                }
              }}
            >
              <strong>{PROVIDER_META[kind].label}</strong>
              <span>
                {kind === "chatgpt"
                  ? "启动后在独立窗口登录"
                  : kind === "openrouter-deepseek"
                    ? "Responses API，适配 Codex"
                    : "兼容 Responses 的接口"}
              </span>
            </button>
          ))}
        </fieldset>

        {provider !== "chatgpt" && (
          <div className="api-fields">
            {provider === "custom" && (
              <label className="field">
                <span>接口地址</span>
                <input
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="https://api.example.com/v1"
                />
              </label>
            )}
            <label className="field">
              <span>模型</span>
              <input
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="模型 ID"
              />
            </label>
            <label className="field">
              <span>API Key</span>
              <input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={profile?.hasApiKey ? "已保存；留空保持不变" : "仅加密保存在本机"}
                autoComplete="off"
              />
            </label>
            {provider === "openrouter-deepseek" && (
              <p className="field-note">
                DeepSeek 官方接口目前是 Chat Completions；Codex 只接受 Responses，因此此预设经
                OpenRouter 连接 DeepSeek。
              </p>
            )}
          </div>
        )}

        {profile?.configurationSource === "cc-switch" && (
          <p className="import-edit-note">
            此配置保留了 CC Switch 的完整 TOML。只改名称或识别色不会影响导入配置；修改连接方式、地址或模型后将转为 Codex Deck 管理。
          </p>
        )}

        {!profile && provider === "chatgpt" && (
          <label className="check-row">
            <input
              type="checkbox"
              checked={importCurrentSession}
              onChange={(event) => setImportCurrentSession(event.target.checked)}
            />
            <span>
              <strong>导入当前 Codex 登录</strong>
              <small>复制现有 auth.json；不勾选则在新窗口登录</small>
            </span>
          </label>
        )}

        <div className="color-row">
          <span>识别色</span>
          <div>
            {COLORS.map((value) => (
              <button
                type="button"
                key={value}
                className={color === value ? "color selected" : "color"}
                style={{ background: value }}
                onClick={() => setColor(value)}
                aria-label={`选择颜色 ${value}`}
              />
            ))}
          </div>
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button" disabled={saving || !name.trim()}>
            {saving ? "保存中…" : profile ? "保存修改" : "创建配置"}
          </button>
        </div>
      </form>
    </div>
  );
}

function CcSwitchImportDialog({
  scan,
  onClose,
  onImported,
}: {
  scan: CcSwitchScanResult;
  onClose: () => void;
  onImported: (result: CcSwitchImportResult) => Promise<void>;
}) {
  const available = scan.candidates.filter(
    (candidate) => candidate.compatible && !candidate.alreadyImported,
  );
  const [selected, setSelected] = useState(
    () => new Set(available.map((candidate) => candidate.sourceId)),
  );
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(scan.warning ?? null);

  function toggle(sourceId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(sourceId)) next.delete(sourceId);
      else next.add(sourceId);
      return next;
    });
  }

  async function runImport() {
    setImporting(true);
    setError(null);
    try {
      const result = await window.codexDeck.importCcSwitch([...selected]);
      await onImported(result);
    } catch (importError) {
      setError(cleanError(importError));
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        className="modal cc-import-modal"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <span className="eyebrow">CC SWITCH IMPORT</span>
            <h3>导入已有配置</h3>
          </div>
          <button type="button" className="close-button" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <p className="import-intro">
          Codex Deck 只读扫描 CC Switch 数据库。API Key 会转入系统加密存储，OAuth 登录态会复制到各自隔离的 Codex Home。
        </p>

        <div className="cc-candidate-list">
          {scan.candidates.length === 0 ? (
            <div className="candidate-empty">没有找到可读取的 Codex provider。</div>
          ) : (
            scan.candidates.map((candidate) => {
              const disabled = !candidate.compatible || candidate.alreadyImported;
              return (
                <label
                  key={candidate.sourceId}
                  className={`cc-candidate ${disabled ? "disabled" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(candidate.sourceId)}
                    disabled={disabled}
                    onChange={() => toggle(candidate.sourceId)}
                  />
                  <span className="candidate-copy">
                    <strong>
                      {candidate.name}
                      {candidate.isCurrent && <em>当前</em>}
                    </strong>
                    <small>
                      {candidate.credentialKind === "oauth"
                        ? "OAuth 账号"
                        : candidate.credentialKind === "api-key"
                          ? "API Key"
                          : "认证未知"}
                      {candidate.model ? ` · ${candidate.model}` : ""}
                    </small>
                    {(candidate.reason || candidate.alreadyImported) && (
                      <span className="candidate-reason">
                        {candidate.alreadyImported ? "已经导入" : candidate.reason}
                      </span>
                    )}
                  </span>
                </label>
              );
            })
          )}
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className="import-footnote">
          <span>不会修改或删除 CC Switch 数据</span>
          <span>{selected.size} 个已选择</span>
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={importing || selected.size === 0}
            onClick={() => void runImport()}
          >
            {importing ? "导入中…" : `导入 ${selected.size} 个配置`}
          </button>
        </div>
      </section>
    </div>
  );
}

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': Error: /, "");
}

function PlusIcon() {
  return <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>;
}

function GearIcon() {
  return <svg viewBox="0 0 24 24"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 8.96 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3v-4h.08A1.7 1.7 0 0 0 4.6 8.94a1.7 1.7 0 0 0-.34-1.88L4.2 7l2.83-2.83.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 10 3.01V3h4v.08a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.56 1.03H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z" /></svg>;
}

function EditIcon() {
  return <svg viewBox="0 0 24 24"><path d="m4 20 4.2-1 10.6-10.6a2 2 0 0 0-2.8-2.8L5.4 16.2 4 20Z" /><path d="m14.6 7 2.8 2.8" /></svg>;
}

function TrashIcon() {
  return <svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" /></svg>;
}

function StopIcon() {
  return <svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1" /></svg>;
}

export default App;
