import type { ReactiveController, ReactiveControllerHost } from 'lit'
import type { PromptConfirmDetail } from '../components/prompt-dialog'

type ConfirmConfig = { message: string; detail: string; confirmLabel: string; action: () => void }
type PromptConfig = {
  message: string
  detail: string
  confirmLabel: string
  placeholder: string
  action: (value: string) => void
}

// Owns the modal confirm/prompt dialogs the workbench pops for destructive or
// input actions. The dialog views are their own components; this holds which
// one is open and runs its action on accept. Setting confirm/prompt re-renders
// the host, so call sites just assign a config (or null to dismiss).
export class DialogsController implements ReactiveController {
  private _confirm: ConfirmConfig | null = null
  private _prompt: PromptConfig | null = null
  private host: ReactiveControllerHost

  constructor(host: ReactiveControllerHost) {
    this.host = host
    host.addController(this)
  }

  hostDisconnected() {
    this._confirm = null
    this._prompt = null
  }

  get confirm() {
    return this._confirm
  }
  set confirm(config: ConfirmConfig | null) {
    this._confirm = config
    this.host.requestUpdate()
  }

  get prompt() {
    return this._prompt
  }
  set prompt(config: PromptConfig | null) {
    this._prompt = config
    this.host.requestUpdate()
  }

  // Error notice via the confirm dialog, with only an acknowledge action.
  notice(message: string, detail: string) {
    this.confirm = { message, detail, confirmLabel: 'OK', action: () => {} }
  }

  acceptConfirm = () => {
    const action = this._confirm?.action
    this.confirm = null
    action?.()
  }

  acceptPrompt = (event: Event) => {
    const { value } = (event as CustomEvent<PromptConfirmDetail>).detail
    const action = this._prompt?.action
    this.prompt = null
    action?.(value)
  }
}
