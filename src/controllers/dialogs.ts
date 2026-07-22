import type { ReactiveController, ReactiveControllerHost } from 'lit'
import type { PromptConfirmDetail } from '../components/prompt-dialog'
import { t } from '../i18n'

type ConfirmConfig = { message: string; detail: string; confirmLabel: string; action: () => void }
type PromptConfig = {
  message: string
  detail: string
  confirmLabel: string
  placeholder: string
  allowEmpty?: boolean
  trim?: boolean
  action: (value: string) => void
}
// A generated write statement awaiting the user's review before it runs. `run`
// resolves to an error message to show inline in the dialog, or null on success.
type ReviewConfig = { sql: string; params: unknown[]; warning?: string; run: () => Promise<string | null> }

// Owns the modal confirm/prompt dialogs the workbench pops for destructive or
// input actions. The dialog views are their own components; this holds which
// one is open and runs its action on accept. Setting confirm/prompt re-renders
// the host, so call sites just assign a config (or null to dismiss).
export class DialogsController implements ReactiveController {
  // FIFO queues, not single slots: a second dialog opened while one is showing
  // (e.g. an async status push raising a notice over an open confirm) must not
  // silently drop either. The head is what's rendered; dismiss/accept pops it
  // and reveals the next.
  private _confirmQueue: ConfirmConfig[] = []
  private _promptQueue: PromptConfig[] = []
  private _reviewQueue: ReviewConfig[] = []
  private host: ReactiveControllerHost

  constructor(host: ReactiveControllerHost) {
    this.host = host
    host.addController(this)
  }

  hostDisconnected() {
    this._confirmQueue = []
    this._promptQueue = []
    this._reviewQueue = []
  }

  // Setting a config enqueues it; setting null dismisses the current (head) one.
  get confirm() {
    return this._confirmQueue[0] ?? null
  }
  set confirm(config: ConfirmConfig | null) {
    if (config) this._confirmQueue.push(config)
    else this._confirmQueue.shift()
    this.host.requestUpdate()
  }

  get prompt() {
    return this._promptQueue[0] ?? null
  }
  set prompt(config: PromptConfig | null) {
    if (config) this._promptQueue.push(config)
    else this._promptQueue.shift()
    this.host.requestUpdate()
  }

  get review() {
    return this._reviewQueue[0] ?? null
  }
  set review(config: ReviewConfig | null) {
    if (config) this._reviewQueue.push(config)
    else this._reviewQueue.shift()
    this.host.requestUpdate()
  }

  // Error notice via the confirm dialog, with only an acknowledge action.
  notice(message: string, detail: string) {
    this.confirm = { message, detail, confirmLabel: t('common.ok'), action: () => {} }
  }

  acceptConfirm = () => {
    const current = this._confirmQueue.shift()
    this.host.requestUpdate()
    current?.action()
  }

  acceptPrompt = (event: Event) => {
    const { value } = (event as CustomEvent<PromptConfirmDetail>).detail
    const current = this._promptQueue.shift()
    this.host.requestUpdate()
    current?.action(value)
  }
}
