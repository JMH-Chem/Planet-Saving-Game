/** 화면 안 대화창의 포커스와 배경 입력을 함께 관리한다. */
export class ModalDialogs {
  private active: HTMLElement | null = null;
  private returnFocus: HTMLElement | null = null;

  constructor(private dialogs: HTMLElement[], private backgrounds: HTMLElement[]) {
    for (const dialog of dialogs) {
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      const heading = dialog.querySelector<HTMLElement>('h1, h2');
      if (heading) {
        heading.id ||= `${dialog.id}-heading`;
        heading.tabIndex = -1;
        dialog.setAttribute('aria-labelledby', heading.id);
      }
    }
  }

  open(dialog: HTMLElement, initialFocus: HTMLElement): void {
    if (!this.active) this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.active = dialog;
    for (const other of this.dialogs) {
      other.hidden = other !== dialog;
      other.inert = other !== dialog;
    }
    for (const background of this.backgrounds) background.inert = true;
    initialFocus.focus({ preventScroll: true });
  }

  close(): void {
    const target = this.returnFocus;
    this.reset();
    if (target?.isConnected && !target.closest('[hidden], [inert]') && target.getClientRects().length) {
      target.focus({ preventScroll: true });
    }
  }

  /** 메뉴 이동·재시작은 이전 화면으로 포커스를 돌리지 않는다. */
  reset(): boolean {
    const wasOpen = this.active !== null;
    if (this.active) this.active.hidden = true;
    this.active = null;
    this.returnFocus = null;
    for (const background of this.backgrounds) background.inert = false;
    for (const dialog of this.dialogs) dialog.inert = false;
    return wasOpen;
  }

  trapTab(event: KeyboardEvent): void {
    if (event.key !== 'Tab' || !this.active) return;
    const controls = [...this.active.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((el) => !el.closest('[hidden], [inert]') && el.getClientRects().length > 0);
    if (!controls.length) return;
    event.preventDefault();
    const index = controls.indexOf(document.activeElement as HTMLElement);
    const next = index < 0 ? (event.shiftKey ? controls.length - 1 : 0)
      : (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
    controls[next].focus();
  }
}
