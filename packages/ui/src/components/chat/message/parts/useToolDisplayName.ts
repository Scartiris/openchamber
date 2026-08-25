import { useI18n } from '@/lib/i18n';
import { getToolMetadata } from '@/lib/toolHelpers';

/**
 * i18n keys for well-known tool display names. Unknown tools (MCP, plugins)
 * fall back to the metadata-derived name so nothing renders blank.
 */
export const TOOL_NAME_I18N_KEY = {
  read: 'chat.toolName.read',
  write: 'chat.toolName.write',
  edit: 'chat.toolName.edit',
  multiedit: 'chat.toolName.multiedit',
  apply_patch: 'chat.toolName.applyPatch',
  bash: 'chat.toolName.bash',
  grep: 'chat.toolName.grep',
  glob: 'chat.toolName.glob',
  list: 'chat.toolName.list',
  task: 'chat.toolName.task',
  webfetch: 'chat.toolName.webfetch',
  websearch: 'chat.toolName.websearch',
  codesearch: 'chat.toolName.codesearch',
  todowrite: 'chat.toolName.todowrite',
  todoread: 'chat.toolName.todoread',
  skill: 'chat.toolName.skill',
  question: 'chat.toolName.question',
  lsp: 'chat.toolName.lsp',
  openchamber_web: 'chat.toolName.openchamberWeb',
  openchamber_memory: 'chat.toolName.openchamberMemory',
  plan_enter: 'chat.toolName.planEnter',
  plan_exit: 'chat.toolName.planExit',
  structuredoutput: 'chat.toolName.structuredOutput',
} as const;

export const useToolDisplayName = (rawToolName: string): string => {
  const { t } = useI18n();
  const key = (TOOL_NAME_I18N_KEY as Record<string, string>)[rawToolName];
  if (key) return (t as (key: string) => string)(key);
  return getToolMetadata(rawToolName).displayName;
};
