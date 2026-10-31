import { createContext } from 'react'
import type { WorkspaceId } from './types'

export const WorkspaceContext = createContext<{
  id: WorkspaceId
  select: (id: WorkspaceId) => void
} | null>(null)
