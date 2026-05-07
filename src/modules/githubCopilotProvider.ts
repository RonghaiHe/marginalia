/**
 * GitHub Copilot provider for Marginalia.
 *
 * Flow:
 *   1. Start Device Flow → get user_code + verification_uri
 *   2. User visits URL and enters code in browser
 *   3. Poll GitHub until access_token is granted
 *   4. Store the GitHub access_token in Zotero prefs
 *   5. On each API call, exchange GitHub token for a short-lived Copilot token
 *      (cached in prefs and in-memory, refreshed automatically when expired)
 *   6. Use Copilot token + endpoint as a drop-in OpenAI-compatible config
 */

const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const DEFAULT_COPILOT_BASE_URL = "https://api.individual.githubcopilot.com";
/** Safety margin before Copilot token expiry (5 minutes) */
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000;

const PREF_PREFIX = "extensions.zotero.marginalia";

export interface CopilotTokenCache {
  token: string;
  expiresAt: number; // milliseconds since epoch
  baseUrl: string;
}

export interface GitHubDeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number; // seconds
  interval: number; // seconds
}

export class GitHubCopilotProvider {
  /** In-memory Copilot token cache (cleared on plugin reload) */
  private tokenCache: CopilotTokenCache | null = null;

  // ─── Pref helpers ────────────────────────────────────────────────────────

  private getPref(key: string): string | null {
    try {
      return Zotero.Prefs.get(`${PREF_PREFIX}.${key}`, true) as string | null;
    } catch {
      return null;
    }
  }

  private setPref(key: string, value: string) {
    Zotero.Prefs.set(`${PREF_PREFIX}.${key}`, value, true);
  }

  private clearPref(key: string) {
    try {
      Zotero.Prefs.clear(`${PREF_PREFIX}.${key}`, true);
    } catch {
      // ignore
    }
  }

  // ─── GitHub access token ─────────────────────────────────────────────────

  getGitHubToken(): string {
    return this.getPref("githubToken") || "";
  }

  setGitHubToken(token: string) {
    this.setPref("githubToken", token);
    // Invalidate Copilot token cache when GitHub token changes
    this.tokenCache = null;
    this.clearPref("copilotTokenCache");
  }

  clearGitHubToken() {
    this.clearPref("githubToken");
    this.tokenCache = null;
    this.clearPref("copilotTokenCache");
  }

  isConfigured(): boolean {
    return !!this.getGitHubToken();
  }

  // ─── Copilot model selection ─────────────────────────────────────────────

  getCopilotModel(): string {
    return this.getPref("copilotModel") || "gpt-4o";
  }

  setCopilotModel(model: string) {
    this.setPref("copilotModel", model);
  }

  static getAvailableModels(): string[] {
    return [
      "GPT-5 mini",
      "GPT-4o",
      "GPT-4.1",
      "Raptor mini",
      "Claude Haiku 4.5",
      "Gemini 3 Flash",
      "GPT-5.4 mini",
      "Gemini 2.5 Pro",
      "Gemini 3.1 Pro",
    ];
  }

  // ─── GitHub Device Flow ──────────────────────────────────────────────────

  /**
   * Step 1: Request a device code from GitHub.
   * Returns info needed to display to the user (user_code + verification_uri).
   */
  async startDeviceFlow(): Promise<GitHubDeviceCode> {
    const body = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      scope: "read:user",
    });

    const res = await fetch(DEVICE_CODE_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!res.ok) {
      throw new Error(`GitHub device code request failed: HTTP ${res.status}`);
    }

    const data = (await res.json() as unknown) as GitHubDeviceCode;
    if (!data.device_code || !data.user_code || !data.verification_uri) {
      throw new Error("Invalid device code response from GitHub");
    }
    return data;
  }

  /**
   * Step 2 (async): Poll GitHub until the user completes authorization.
   * Calls `onWaiting` each poll cycle.
   * Returns the GitHub personal access token on success.
   */
  async pollForAccessToken(
    deviceCode: string,
    intervalSeconds: number,
    expiresAt: number,
    onWaiting?: () => void,
    signal?: AbortSignal,
  ): Promise<string> {
    const pollMs = Math.max(5000, intervalSeconds * 1000);
    const body = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });

    while (Date.now() < expiresAt) {
      if (signal?.aborted) throw new Error("Login cancelled.");
      await new Promise((r) => setTimeout(r, pollMs));
      if (signal?.aborted) throw new Error("Login cancelled.");

      const res = await fetch(ACCESS_TOKEN_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });

      if (!res.ok) {
        throw new Error(`GitHub token poll failed: HTTP ${res.status}`);
      }

      const data = (await res.json() as unknown) as Record<string, string>;

      if (data.access_token) {
        return data.access_token;
      }

      const err = data.error;
      if (err === "authorization_pending") {
        onWaiting?.();
        continue;
      }
      if (err === "slow_down") {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      if (err === "expired_token") {
        throw new Error("GitHub device code expired. Please try again.");
      }
      if (err === "access_denied") {
        throw new Error("GitHub login was cancelled.");
      }
      throw new Error(`GitHub authorization error: ${err ?? "unknown"}`);
    }

    throw new Error("GitHub device code expired. Please try again.");
  }

  // ─── Copilot token management ────────────────────────────────────────────

  /**
   * Exchange a GitHub access token for a short-lived Copilot API token.
   */
  async fetchCopilotToken(githubToken: string): Promise<CopilotTokenCache> {
    const res = await fetch(COPILOT_TOKEN_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${githubToken}`,
        "User-Agent": "marginalia-zotero-plugin/1.0",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Copilot token exchange failed: HTTP ${res.status} — ${text}`,
      );
    }

    const data = (await res.json() as unknown) as { token: string; expires_at: number };
    if (!data.token) {
      throw new Error("Copilot token response missing 'token' field");
    }

    // GitHub returns unix timestamp in seconds; convert to ms
    const expiresAt =
      data.expires_at > 10_000_000_000
        ? data.expires_at
        : data.expires_at * 1000;

    const baseUrl = this.deriveBaseUrl(data.token);
    return { token: data.token, expiresAt, baseUrl };
  }

  /** Derive the Copilot proxy base URL from the semicolon-delimited token. */
  private deriveBaseUrl(token: string): string {
    const match = token.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i);
    const proxyEp = match?.[1]?.trim();
    if (!proxyEp) return DEFAULT_COPILOT_BASE_URL;
    // Convert proxy.* hostname to api.*
    const host = proxyEp
      .replace(/^https?:\/\//, "")
      .replace(/^proxy\./i, "api.");
    return `https://${host}`;
  }

  /**
   * Return a valid Copilot { token, baseUrl }, refreshing automatically when
   * close to expiry. Throws if GitHub token is not set.
   */
  async getValidToken(): Promise<{ token: string; baseUrl: string }> {
    // 1. In-memory cache
    if (
      this.tokenCache &&
      this.tokenCache.expiresAt - Date.now() > TOKEN_EXPIRY_MARGIN_MS
    ) {
      return { token: this.tokenCache.token, baseUrl: this.tokenCache.baseUrl };
    }

    // 2. Pref cache
    const cached = this.loadTokenCache();
    if (
      cached &&
      cached.expiresAt - Date.now() > TOKEN_EXPIRY_MARGIN_MS
    ) {
      this.tokenCache = cached;
      return { token: cached.token, baseUrl: cached.baseUrl };
    }

    // 3. Fetch fresh token
    const githubToken = this.getGitHubToken();
    if (!githubToken) {
      throw new Error(
        "GitHub Copilot is not configured. Please log in via Marginalia preferences.",
      );
    }

    ztoolkit.log("[CopilotProvider] Fetching new Copilot token…");
    const fresh = await this.fetchCopilotToken(githubToken);
    this.tokenCache = fresh;
    this.saveTokenCache(fresh);
    return { token: fresh.token, baseUrl: fresh.baseUrl };
  }

  private loadTokenCache(): CopilotTokenCache | null {
    try {
      const json = this.getPref("copilotTokenCache");
      if (!json) return null;
      return JSON.parse(json) as CopilotTokenCache;
    } catch {
      return null;
    }
  }

  private saveTokenCache(cache: CopilotTokenCache) {
    try {
      this.setPref("copilotTokenCache", JSON.stringify(cache));
    } catch (e) {
      ztoolkit.log("[CopilotProvider] Failed to save token cache:", e);
    }
  }

  // ─── APIClient-compatible config ─────────────────────────────────────────

  /**
   * Build an APIConfig (url + apiKey + model) suitable for use with APIClient.
   * The URL ends with "/chat/completions" so APIClient uses it verbatim.
   */
  async getAPIConfig(): Promise<{
    url: string;
    apiKey: string;
    model: string;
    extraHeaders: Record<string, string>;
  }> {
    const { token, baseUrl } = await this.getValidToken();
    return {
      url: `${baseUrl}/chat/completions`,
      apiKey: token,
      model: this.getCopilotModel(),
      extraHeaders: {
        "Copilot-Integration-Id": "vscode-chat",
        "Editor-Version": "vscode/1.95.0",
      },
    };
  }
}

/** Singleton instance shared across the plugin runtime. */
export const copilotProvider = new GitHubCopilotProvider();
