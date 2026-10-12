const FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export class DialogManager {
  constructor(document) {
    this.document = document;
    this.stack = [];
    this.inertStates = new Map();
    document.addEventListener("keydown", (event) => this.trapTab(event));
    document.addEventListener("focusin", (event) => {
      if (this.active && !this.active.contains(event.target)) this.focusFirst(this.active);
    });
  }

  get active() { return this.stack.at(-1)?.element || null; }

  focusable(element) {
    return [...element.querySelectorAll(FOCUSABLE)].filter((target) =>
      !target.disabled && target.tabIndex >= 0 && !target.closest("[inert]") && target.getClientRects().length > 0
    );
  }

  focusFirst(element) {
    const targets = this.focusable(element);
    (targets.find((target) => target.hasAttribute("autofocus")) || targets[0] || element).focus({ preventScroll: true });
  }

  syncBackground() {
    const active = this.active;
    // Dialogs are body-level siblings; only the top dialog remains interactive.
    for (const element of this.document.body.children) {
      if (element.id === "toast" || element.tagName === "SCRIPT") continue;
      if (active) {
        if (!this.inertStates.has(element)) this.inertStates.set(element, element.inert);
        element.inert = element !== active;
      }
    }
    if (!active) {
      for (const [element, inert] of this.inertStates) element.inert = inert;
      this.inertStates.clear();
    }
  }

  open(element) {
    if (!element) return;
    const existing = this.stack.findIndex((entry) => entry.element === element);
    if (existing !== -1) return;
    this.stack.push({ element, opener: this.document.activeElement });
    element.classList.remove("hidden");
    element.setAttribute("aria-hidden", "false");
    if (!element.hasAttribute("tabindex")) element.tabIndex = -1;
    this.syncBackground();
    this.focusFirst(element);
  }

  close(element) {
    if (!element) return;
    const index = this.stack.findIndex((entry) => entry.element === element);
    const wasActive = this.active === element;
    const entry = index === -1 ? null : this.stack.splice(index, 1)[0];
    element.classList.add("hidden");
    element.setAttribute("aria-hidden", "true");
    this.syncBackground();
    if (!wasActive) return;
    const opener = entry.opener;
    if (opener?.isConnected && !opener.disabled && !opener.closest("[inert]") && opener.getClientRects().length
        && (!this.active || this.active.contains(opener))) {
      opener.focus({ preventScroll: true });
    } else if (this.active) {
      this.focusFirst(this.active);
    }
  }

  trapTab(event) {
    if (event.key !== "Tab" || !this.active) return;
    const targets = this.focusable(this.active);
    const index = targets.indexOf(this.document.activeElement);
    if (!targets.length) {
      event.preventDefault();
      this.active.focus({ preventScroll: true });
    } else if (index === -1 || (event.shiftKey && index === 0) || (!event.shiftKey && index === targets.length - 1)) {
      event.preventDefault();
      targets[event.shiftKey ? targets.length - 1 : 0].focus({ preventScroll: true });
    }
  }
}
