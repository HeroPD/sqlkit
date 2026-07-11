// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TableRef } from '../electron'
import './inspect-add-dialog'
import type { AddObjectDetail, InspectAddDialog } from './inspect-add-dialog'

const users: TableRef = { schema: 'public', name: 'users', kind: 'table' }

const mount = async (setup: (el: InspectAddDialog) => void): Promise<InspectAddDialog> => {
  const el = document.createElement('inspect-add-dialog')
  el.table = users
  setup(el)
  document.body.append(el)
  await el.updateComplete
  return el
}

afterEach(() => {
  document.body.innerHTML = ''
})

const setInput = async (el: InspectAddDialog, selector: string, value: string) => {
  const input = el.shadowRoot!.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!
  input.value = value
  input.dispatchEvent(new Event('input'))
  await el.updateComplete
}

const create = (el: InspectAddDialog) => {
  el.shadowRoot!.querySelector<HTMLButtonElement>('button.primary')!.click()
}

describe('inspect-add-dialog: index', () => {
  it('builds a CREATE INDEX from the picked columns and emits add-ddl', async () => {
    const el = await mount((dialog) => {
      dialog.kind = 'index'
      dialog.engine = 'postgresql'
      dialog.columns = ['id', 'name', 'age']
    })
    const onDdl = vi.fn()
    el.addEventListener('add-ddl', onDdl)

    await setInput(el, 'input[type="text"]', 'idx_users_name')
    // Pick age then name; key order must still follow the table column order.
    const checks = [...el.shadowRoot!.querySelectorAll<HTMLInputElement>('.checks input[type="checkbox"]')]
    checks[2]!.click()
    checks[1]!.click()
    await el.updateComplete
    create(el)

    expect(onDdl).toHaveBeenCalledOnce()
    const detail = (onDdl.mock.calls[0]![0] as CustomEvent<AddObjectDetail>).detail
    expect(detail.statements).toEqual(['CREATE INDEX "idx_users_name" ON "public"."users" ("name", "age")'])
  })

  it('shows the builder error inline instead of emitting', async () => {
    const el = await mount((dialog) => {
      dialog.kind = 'index'
      dialog.engine = 'sqlite'
      dialog.columns = ['id']
    })
    const onDdl = vi.fn()
    el.addEventListener('add-ddl', onDdl)
    create(el)
    await el.updateComplete

    expect(onDdl).not.toHaveBeenCalled()
    expect(el.shadowRoot!.querySelector('.error')?.textContent).toContain('name')
  })
})

describe('inspect-add-dialog: trigger', () => {
  it('offers a single-event select and body on MySQL and emits the wrapped trigger', async () => {
    const el = await mount((dialog) => {
      dialog.kind = 'trigger'
      dialog.engine = 'mysql'
    })
    const onDdl = vi.fn()
    el.addEventListener('add-ddl', onDdl)

    // Single-event engines get a select, not checkboxes; no FOR EACH picker (ROW only).
    expect(el.shadowRoot!.querySelectorAll('.checks.row input').length).toBe(0)
    await setInput(el, 'input[type="text"]', 'trg_users')
    await setInput(el, 'textarea', 'SET NEW.updated_at = NOW()')
    create(el)

    const detail = (onDdl.mock.calls[0]![0] as CustomEvent<AddObjectDetail>).detail
    expect(detail.statements[0]).toBe(
      'CREATE TRIGGER `trg_users`\nBEFORE INSERT ON `public`.`users`\nFOR EACH ROW\nBEGIN\nSET NEW.updated_at = NOW();\nEND',
    )
  })

  it('asks for a function name on PostgreSQL', async () => {
    const el = await mount((dialog) => {
      dialog.kind = 'trigger'
      dialog.engine = 'postgresql'
    })
    const onDdl = vi.fn()
    el.addEventListener('add-ddl', onDdl)

    expect(el.shadowRoot!.querySelector('textarea')).toBeNull()
    await setInput(el, 'input[type="text"]', 'audit')
    await setInput(el, 'input[placeholder="schema.function_name"]', 'log_change')
    create(el)

    const detail = (onDdl.mock.calls[0]![0] as CustomEvent<AddObjectDetail>).detail
    expect(detail.statements[0]).toContain('FOR EACH ROW EXECUTE FUNCTION log_change()')
  })
})

describe('inspect-add-dialog: foreign key', () => {
  it('builds ALTER TABLE ADD CONSTRAINT FOREIGN KEY with picked columns and actions', async () => {
    const el = await mount((dialog) => {
      dialog.kind = 'foreignKey'
      dialog.engine = 'postgresql'
      dialog.columns = ['id', 'user_id']
    })
    const onDdl = vi.fn()
    el.addEventListener('add-ddl', onDdl)

    await setInput(el, 'input[type="text"]', 'fk_users_user')
    // Second column checkbox = user_id.
    el.shadowRoot!.querySelectorAll<HTMLInputElement>('.checks input[type="checkbox"]')[1]!.click()
    await el.updateComplete
    const texts = [...el.shadowRoot!.querySelectorAll<HTMLInputElement>('input[type="text"]')]
    texts.find((i) => i.placeholder === 'schema.table')!.value = 'public.accounts'
    texts.find((i) => i.placeholder === 'schema.table')!.dispatchEvent(new Event('input'))
    texts.find((i) => i.placeholder === 'id')!.value = 'id'
    texts.find((i) => i.placeholder === 'id')!.dispatchEvent(new Event('input'))
    const onDelete = el.shadowRoot!.querySelectorAll<HTMLSelectElement>('select')[0]!
    onDelete.value = 'CASCADE'
    onDelete.dispatchEvent(new Event('change'))
    await el.updateComplete
    create(el)

    const detail = (onDdl.mock.calls[0]![0] as CustomEvent<AddObjectDetail>).detail
    expect(detail.statements[0]).toBe(
      'ALTER TABLE "public"."users" ADD CONSTRAINT "fk_users_user" FOREIGN KEY ("user_id") REFERENCES "public"."accounts" ("id") ON DELETE CASCADE',
    )
  })
})

describe('inspect-add-dialog: constraint', () => {
  it('builds a CHECK from the expression', async () => {
    const el = await mount((dialog) => {
      dialog.kind = 'constraint'
      dialog.engine = 'postgresql'
      dialog.columns = ['age']
    })
    const onDdl = vi.fn()
    el.addEventListener('add-ddl', onDdl)

    await setInput(el, 'input[type="text"]', 'age_nonneg')
    await setInput(el, 'textarea', 'age >= 0')
    create(el)

    const detail = (onDdl.mock.calls[0]![0] as CustomEvent<AddObjectDetail>).detail
    expect(detail.statements[0]).toBe('ALTER TABLE "public"."users" ADD CONSTRAINT "age_nonneg" CHECK (age >= 0)')
  })

  it('switches to UNIQUE and picks columns', async () => {
    const el = await mount((dialog) => {
      dialog.kind = 'constraint'
      dialog.engine = 'mysql'
      dialog.columns = ['email', 'tenant']
    })
    const onDdl = vi.fn()
    el.addEventListener('add-ddl', onDdl)

    await setInput(el, 'input[type="text"]', 'uq_email')
    const typeSelect = el.shadowRoot!.querySelector<HTMLSelectElement>('select')!
    typeSelect.value = 'UNIQUE'
    typeSelect.dispatchEvent(new Event('change'))
    await el.updateComplete
    el.shadowRoot!.querySelectorAll<HTMLInputElement>('.checks input[type="checkbox"]').forEach((box) => box.click())
    await el.updateComplete
    create(el)

    const detail = (onDdl.mock.calls[0]![0] as CustomEvent<AddObjectDetail>).detail
    expect(detail.statements[0]).toBe('ALTER TABLE `public`.`users` ADD CONSTRAINT `uq_email` UNIQUE (`email`, `tenant`)')
  })
})

describe('inspect-add-dialog: partition', () => {
  it('emits a PARTITION OF statement with the typed bounds', async () => {
    const el = await mount((dialog) => {
      dialog.kind = 'partition'
      dialog.engine = 'postgresql'
    })
    const onDdl = vi.fn()
    el.addEventListener('add-ddl', onDdl)

    const inputs = [...el.shadowRoot!.querySelectorAll<HTMLInputElement>('input[type="text"]')]
    inputs[0]!.value = 'users_2026'
    inputs[0]!.dispatchEvent(new Event('input'))
    inputs[1]!.value = 'IN (1, 2)'
    inputs[1]!.dispatchEvent(new Event('input'))
    await el.updateComplete
    create(el)

    const detail = (onDdl.mock.calls[0]![0] as CustomEvent<AddObjectDetail>).detail
    expect(detail.statements).toEqual(['CREATE TABLE "public"."users_2026" PARTITION OF "public"."users" FOR VALUES IN (1, 2)'])
  })

  it('cancels from the backdrop without emitting', async () => {
    const el = await mount((dialog) => {
      dialog.kind = 'partition'
      dialog.engine = 'mysql'
    })
    const cancelled = vi.fn()
    el.addEventListener('dialog-cancel', cancelled)
    el.shadowRoot!.querySelector<HTMLElement>('.backdrop')!.dispatchEvent(new MouseEvent('mousedown'))
    expect(cancelled).toHaveBeenCalledOnce()
  })
})
