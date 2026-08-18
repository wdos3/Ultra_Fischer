const state = {
  lastFocus: null,
  pendingEmail: "",
  resendUntil: 0,
  timer: null,
  user: null,
};

const ui = {
  accountButton: document.getElementById("account-button"),
  accountEmail: document.getElementById("account-email"),
  authClose: document.getElementById("auth-close"),
  authDialog: document.getElementById("auth-dialog"),
  authStatus: document.getElementById("auth-status"),
  changePasswordForm: document.getElementById("change-password-form"),
  forgotForm: document.getElementById("forgot-form"),
  loginForm: document.getElementById("login-form"),
  logoutButton: document.getElementById("logout-button"),
  registerButton: document.getElementById("register-button"),
  registerForm: document.getElementById("register-form"),
  resendCode: document.getElementById("resend-code"),
  resetForm: document.getElementById("reset-form"),
  signInButton: document.getElementById("sign-in-button"),
  verificationEmail: document.getElementById("verification-email"),
  verifyForm: document.getElementById("verify-form"),
  views: Array.from(document.querySelectorAll("[data-auth-view]")),
};

function setStatus(message, kind = "") {
  ui.authStatus.textContent = message;
  ui.authStatus.className = `auth-status${kind ? ` ${kind}` : ""}`;
}

function userError(error) {
  if (error?.status === 503) return "Account services are being configured. Guest play is still available.";
  if (error?.status === 429) return "Too many attempts. Please wait a moment and try again.";
  return error?.message || "Something went wrong. Please try again.";
}

async function request(path, options = {}) {
  const headers = { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json", "X-UF-Client": "web" } : {}) };
  const response = await fetch(path, {
    ...options,
    cache: "no-store",
    credentials: "same-origin",
    headers: { ...headers, ...(options.headers || {}) },
  });
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok) {
    const error = new Error(data.error || "Request failed.");
    error.code = data.code;
    error.status = response.status;
    throw error;
  }
  return data;
}

function showView(name, { clearStatus = true } = {}) {
  ui.views.forEach((view) => {
    const active = view.dataset.authView === name;
    view.classList.toggle("hidden", !active);
  });
  if (clearStatus) setStatus("");
  const activeView = ui.views.find((view) => view.dataset.authView === name);
  if (!activeView) return;
  const dialogTitle = {
    login: "Sign in",
    register: "Create an account",
    verify: "Confirm your email",
    forgot: "Reset your password",
    reset: "Choose a new password",
    account: "Account security",
  }[name];
  document.getElementById("auth-title").textContent = dialogTitle || "Account";
  window.setTimeout(() => {
    const firstField = activeView.querySelector("input:not([disabled])");
    firstField?.focus();
  }, 0);
}

function openDialog(name = "login") {
  state.lastFocus = document.activeElement;
  ui.authDialog.classList.remove("hidden");
  ui.authDialog.setAttribute("aria-hidden", "false");
  showView(name);
}

function closeDialog() {
  ui.authDialog.classList.add("hidden");
  ui.authDialog.setAttribute("aria-hidden", "true");
  setStatus("");
  if (state.lastFocus && typeof state.lastFocus.focus === "function" && !state.lastFocus.classList.contains("hidden")) {
    state.lastFocus.focus();
  }
}

function renderAccount() {
  const signedIn = Boolean(state.user);
  ui.signInButton.classList.toggle("hidden", signedIn);
  ui.registerButton.classList.toggle("hidden", signedIn);
  ui.accountButton.classList.toggle("hidden", !signedIn);
  ui.accountButton.setAttribute("aria-expanded", "false");
  if (signedIn) {
    ui.accountEmail.textContent = state.user.email;
  }
}

function setSignedIn(user) {
  state.user = user;
  renderAccount();
}

function setSignedOut() {
  state.user = null;
  renderAccount();
}

function startResendTimer() {
  window.clearInterval(state.timer);
  state.resendUntil = Date.now() + 60000;
  const tick = () => {
    const remaining = Math.ceil(Math.max(0, state.resendUntil - Date.now()) / 1000);
    ui.resendCode.disabled = remaining > 0;
    ui.resendCode.textContent = remaining > 0 ? `Resend code in ${remaining}s` : "Resend code";
    if (!remaining) window.clearInterval(state.timer);
  };
  tick();
  state.timer = window.setInterval(tick, 1000);
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function setFormBusy(form, busy) {
  form.querySelectorAll("button, input").forEach((element) => {
    element.disabled = busy;
  });
}

function notify(message) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("visible");
  window.setTimeout(() => toast.classList.remove("visible"), 2600);
}

async function loadSession() {
  try {
    const data = await request("/api/auth/session");
    if (data.authenticated) setSignedIn(data.user);
    else setSignedOut();
  } catch {
    setSignedOut();
  }
}

async function handleRecoveryLink() {
  const url = new URL(window.location.href);
  const tokenHash = url.searchParams.get("token_hash");
  if (url.searchParams.get("auth") !== "recovery" || !tokenHash) return;
  url.searchParams.delete("auth");
  url.searchParams.delete("token_hash");
  url.searchParams.delete("type");
  window.history.replaceState({}, "", url);
  openDialog("login");
  setStatus("Validating your recovery link...", "success");
  try {
    await request("/api/auth/verify-recovery", {
      method: "POST",
      body: JSON.stringify({ tokenHash }),
    });
    showView("reset", { clearStatus: false });
    setStatus("Recovery link accepted. Choose a new password.", "success");
  } catch (error) {
    showView("login", { clearStatus: false });
    setStatus(userError(error), "error");
  }
}

async function submitForm(form, handler) {
  const emailInput = form.querySelector('input[type="email"]');
  if (emailInput) emailInput.value = emailInput.value.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").trim();
  if (!form.reportValidity()) return;
  setFormBusy(form, true);
  try {
    await handler(formData(form));
  } catch (error) {
    setStatus(userError(error), "error");
  } finally {
    setFormBusy(form, false);
  }
}

function bindEvents() {
  ui.signInButton.addEventListener("click", () => openDialog("login"));
  ui.registerButton.addEventListener("click", () => openDialog("register"));
  ui.accountButton.addEventListener("click", () => {
    ui.accountButton.setAttribute("aria-expanded", "true");
    openDialog("account");
  });
  ui.authClose.addEventListener("click", closeDialog);
  ui.authDialog.addEventListener("click", (event) => {
    if (event.target === ui.authDialog) closeDialog();
  });
  document.querySelectorAll("[data-auth-open]").forEach((button) => {
    button.addEventListener("click", () => showView(button.dataset.authOpen));
  });
  document.querySelectorAll(".password-toggle").forEach((button) => {
    button.addEventListener("click", () => {
      const input = document.getElementById(button.dataset.target);
      const visible = input.type === "text";
      input.type = visible ? "password" : "text";
      button.textContent = visible ? "Show" : "Hide";
      button.setAttribute("aria-label", visible ? "Show password" : "Hide password");
    });
  });

  ui.loginForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitForm(ui.loginForm, async (data) => {
      try {
        const result = await request("/api/auth/login", { method: "POST", body: JSON.stringify(data) });
        setSignedIn(result.user);
        closeDialog();
        notify("Signed in.");
      } catch (error) {
        if (error.code === "email_not_verified") {
          state.pendingEmail = data.email.trim().toLowerCase();
          ui.verificationEmail.textContent = state.pendingEmail;
          showView("verify", { clearStatus: false });
          setStatus("Confirm your email before signing in.", "error");
          return;
        }
        throw error;
      }
    });
  });

  ui.registerForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitForm(ui.registerForm, async (data) => {
      const result = await request("/api/auth/register", { method: "POST", body: JSON.stringify(data) });
      if (result.status === "active") {
        setSignedIn(result.user);
        closeDialog();
        notify("Account created.");
        return;
      }
      state.pendingEmail = data.email.trim().toLowerCase();
      ui.verificationEmail.textContent = result.maskedEmail || state.pendingEmail;
      showView("verify", { clearStatus: false });
      setStatus("Check your inbox for a 6-digit confirmation code.", "success");
      startResendTimer();
    });
  });

  ui.verifyForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitForm(ui.verifyForm, async (data) => {
      const result = await request("/api/auth/verify-email", {
        method: "POST",
        body: JSON.stringify({ email: state.pendingEmail, code: data.code.trim() }),
      });
      setSignedIn(result.user);
      closeDialog();
      notify("Email confirmed. You are signed in.");
    });
  });

  ui.resendCode.addEventListener("click", () => {
    if (Date.now() < state.resendUntil || !state.pendingEmail) return;
    ui.resendCode.disabled = true;
    void request("/api/auth/resend-code", {
      method: "POST",
      body: JSON.stringify({ email: state.pendingEmail }),
    })
      .then(() => {
        setStatus("If the account can receive a code, a new one is on its way.", "success");
        startResendTimer();
      })
      .catch((error) => {
        ui.resendCode.disabled = false;
        setStatus(userError(error), "error");
      });
  });

  ui.forgotForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitForm(ui.forgotForm, async (data) => {
      await request("/api/auth/forgot-password", { method: "POST", body: JSON.stringify(data) });
      setStatus("If an account matches that email, we sent the next steps.", "success");
    });
  });

  ui.resetForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitForm(ui.resetForm, async (data) => {
      await request("/api/auth/reset-password", { method: "POST", body: JSON.stringify(data) });
      setSignedOut();
      showView("login", { clearStatus: false });
      setStatus("Password updated. Sign in with your new password.", "success");
    });
  });

  ui.changePasswordForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitForm(ui.changePasswordForm, async (data) => {
      await request("/api/auth/change-password", { method: "POST", body: JSON.stringify(data) });
      setSignedOut();
      showView("login", { clearStatus: false });
      setStatus("Password changed. Sign in again.", "success");
    });
  });

  ui.logoutButton.addEventListener("click", async () => {
    ui.logoutButton.disabled = true;
    try {
      await request("/api/auth/logout", { method: "POST", body: JSON.stringify({}) });
    } catch {
      // The local session is cleared even if the provider is unavailable.
    }
    setSignedOut();
    closeDialog();
    notify("Signed out.");
    ui.logoutButton.disabled = false;
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !ui.authDialog.classList.contains("hidden")) closeDialog();
  });
}

export function initAuth() {
  if (!ui.authDialog) return;
  renderAccount();
  bindEvents();
  void loadSession().then(handleRecoveryLink);
}
