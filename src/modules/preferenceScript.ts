import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import { APIClient } from "./apiClient";
import { copilotProvider } from "./githubCopilotProvider";
import { SettingsManager } from "./settingsManager";
import { StorageManager } from "./storageManager";

export function registerPrefsPane() {
  Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: getString("prefs-title"),
    image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.svg`,
  });
}

export async function registerPrefsScripts(_window: Window) {
  if (!addon.data.prefs) {
    addon.data.prefs = {
      window: _window,
      columns: [],
      rows: [],
    };
  } else {
    addon.data.prefs.window = _window;
  }
  bindPrefEvents();
}

function bindPrefEvents() {
  const window = addon.data.prefs?.window;
  if (!window) return;

  // ── Vision checkbox ──────────────────────────────────────────────────────
  const enableVisionInput = window.document?.querySelector(
    "#marginalia-enableVision",
  ) as HTMLInputElement;
  if (enableVisionInput) {
    enableVisionInput.checked = !!getPref("enableVision");
  }

  // ── Provider dropdown ────────────────────────────────────────────────────
  const providerSelect = window.document?.querySelector(
    "#marginalia-provider",
  ) as HTMLSelectElement;
  if (providerSelect) {
    const currentProvider = getPref("provider") || "openai";
    providerSelect.value = currentProvider;
    applyProviderUI(window, currentProvider);

    providerSelect.addEventListener("change", () => {
      const selected = providerSelect.value;
      setPref("provider", selected as "openai" | "copilot");
      applyProviderUI(window, selected);
    });
  }

  // ── Copilot model select ─────────────────────────────────────────────────
  const copilotModelSelect = window.document?.querySelector(
    "#marginalia-copilotModel",
  ) as HTMLSelectElement;
  if (copilotModelSelect) {
    const savedModel = getPref("copilotModel") || "gpt-4o";
    copilotModelSelect.value = savedModel;

    copilotModelSelect.addEventListener("change", () => {
      setPref("copilotModel", copilotModelSelect.value);
    });
  }

  // ── Copilot login / logout buttons ───────────────────────────────────────
  const loginBtn = window.document?.querySelector(
    "#marginalia-copilot-login",
  ) as HTMLButtonElement;
  loginBtn?.addEventListener("click", () => {
    void handleCopilotLogin(window);
  });

  const logoutBtn = window.document?.querySelector(
    "#marginalia-copilot-logout",
  ) as HTMLButtonElement;
  logoutBtn?.addEventListener("click", () => {
    copilotProvider.clearGitHubToken();
    updateCopilotStatus(window);
    window.alert(getString("pref-copilot-logout-success"));
  });

  // ── OpenAI-compatible buttons ────────────────────────────────────────────
  const testBtn = window.document?.querySelector("#marginalia-test-connection");
  testBtn?.addEventListener("click", async () => {
    await testAPIConnection(window);
  });

  const saveBtn = window.document?.querySelector("#marginalia-save-settings");
  saveBtn?.addEventListener("click", async () => {
    await saveSettings(window);
  });
}

/** Show/hide OpenAI vs Copilot fieldsets based on the chosen provider. */
function applyProviderUI(window: Window, provider: string) {
  const openaiSection = window.document?.querySelector(
    "#marginalia-openai-section",
  ) as HTMLElement;
  const copilotSection = window.document?.querySelector(
    "#marginalia-copilot-section",
  ) as HTMLElement;

  if (provider === "copilot") {
    if (openaiSection) openaiSection.style.display = "none";
    if (copilotSection) copilotSection.style.display = "";
    updateCopilotStatus(window);
  } else {
    if (openaiSection) openaiSection.style.display = "";
    if (copilotSection) copilotSection.style.display = "none";
  }
}

/** Update the Copilot login status indicator. */
function updateCopilotStatus(window: Window) {
  const statusEl = window.document?.querySelector(
    "#marginalia-copilot-status",
  ) as HTMLElement;
  if (!statusEl) return;

  if (copilotProvider.isConfigured()) {
    statusEl.setAttribute("data-l10n-id", "pref-copilot-status-loggedin");
    statusEl.style.color = "#2a7a2a";
  } else {
    statusEl.setAttribute("data-l10n-id", "pref-copilot-status-not-loggedin");
    statusEl.style.color = "#888";
  }
}

/** GitHub Device Flow login, non-blocking via polling. */
async function handleCopilotLogin(window: Window) {
  const loginBtn = window.document?.querySelector(
    "#marginalia-copilot-login",
  ) as HTMLButtonElement;

  const originalLabel =
    loginBtn?.getAttribute("label") ||
    getString("pref-copilot-login");
  loginBtn?.setAttribute("label", getString("pref-copilot-login-waiting"));
  loginBtn?.setAttribute("disabled", "true");

  try {
    const deviceCode = await copilotProvider.startDeviceFlow();

    // Open the verification URL in the default browser
    Zotero.launchURL(deviceCode.verification_uri);

    // Show the user code in a dialog so the user knows what to enter
    window.alert(
      `GitHub Authorization\n\nVisit: ${deviceCode.verification_uri}\nEnter code: ${deviceCode.user_code}\n\nClick OK to continue waiting in the background.`,
    );

    const expiresAt = Date.now() + deviceCode.expires_in * 1000;
    const githubToken = await copilotProvider.pollForAccessToken(
      deviceCode.device_code,
      deviceCode.interval,
      expiresAt,
    );

    copilotProvider.setGitHubToken(githubToken);
    updateCopilotStatus(window);
    window.alert(getString("pref-copilot-login-success"));
  } catch (error) {
    window.alert(
      getString("pref-copilot-login-error", {
        args: { error: String(error) },
      }),
    );
  } finally {
    loginBtn?.setAttribute("label", originalLabel);
    loginBtn?.removeAttribute("disabled");
  }
}

async function testAPIConnection(window: Window) {
  const testBtn = window.document?.querySelector(
    "#marginalia-test-connection",
  ) as HTMLButtonElement;
  const apiUrlInput = window.document?.querySelector(
    "#marginalia-apiUrl",
  ) as HTMLInputElement;
  const apiKeyInput = window.document?.querySelector(
    "#marginalia-apiKey",
  ) as HTMLInputElement;
  const modelInput = window.document?.querySelector(
    "#marginalia-model",
  ) as HTMLInputElement;

  const url = apiUrlInput?.value || "";
  const apiKey = apiKeyInput?.value || "";
  const model = modelInput?.value || "";

  if (!url || !apiKey || !model) {
    window.alert(getString("pref-fill-all-fields"));
    return;
  }

  const originalLabel =
    testBtn?.getAttribute("label") || getString("pref-test-connection-label");
  testBtn?.setAttribute("label", getString("pref-test-connection-testing"));
  testBtn?.setAttribute("disabled", "true");

  try {
    // 依次探测候选端点，找到第一个可用的完整 URL
    const resolvedUrl = await APIClient.resolveWorkingEndpoint(
      url,
      apiKey,
      model,
    );

    // 回写到输入框（让用户看到实际使用的地址）并持久化
    if (resolvedUrl !== url) {
      apiUrlInput.value = resolvedUrl;
    }
    const storageManager = new StorageManager();
    const settingsManager = new SettingsManager(storageManager);
    await settingsManager.setAPIConfig(resolvedUrl, apiKey, model);
    window.alert(getString("pref-test-connection-success"));
  } catch (error) {
    window.alert(
      getString("pref-test-connection-error", {
        args: { error: String(error) },
      }),
    );
  } finally {
    testBtn?.setAttribute("label", originalLabel);
    testBtn?.removeAttribute("disabled");
  }
}

async function saveSettings(window: Window) {
  const storageManager = new StorageManager();
  const settingsManager = new SettingsManager(storageManager);

  const apiUrlInput = window.document?.querySelector(
    "#marginalia-apiUrl",
  ) as HTMLInputElement;
  const apiKeyInput = window.document?.querySelector(
    "#marginalia-apiKey",
  ) as HTMLInputElement;
  const modelInput = window.document?.querySelector(
    "#marginalia-model",
  ) as HTMLInputElement;
  const enableVisionInput = window.document?.querySelector(
    "#marginalia-enableVision",
  ) as HTMLInputElement;

  const url = apiUrlInput?.value || "";
  const apiKey = apiKeyInput?.value || "";
  const model = modelInput?.value || "";

  if (!url || !apiKey || !model) {
    window.alert(getString("pref-fill-all-fields"));
    return;
  }

  try {
    await settingsManager.setAPIConfig(url, apiKey, model);
    setPref("enableVision", !!enableVisionInput?.checked);
    window.alert(getString("pref-save-success"));
  } catch (error) {
    window.alert(
      getString("pref-save-failed", { args: { error: String(error) } }),
    );
  }
}
