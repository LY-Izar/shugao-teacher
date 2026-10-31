import type { EntryKey } from '../lib/roles'

export type WorkspaceId = 'subject' | 'class' | 'admin'

export type WorkspaceLink = {
  label: string
  to: string
  entry: EntryKey
  currentClass?: boolean
}

export type WorkspaceGroup = {
  label: string
  entry: EntryKey
  to: string
  links: WorkspaceLink[]
}
