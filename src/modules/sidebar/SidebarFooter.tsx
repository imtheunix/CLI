import { Settings } from 'lucide-react';
import type { TFunction } from 'i18next';
type SidebarFooterProps = {

  onShowSettings: () => void;
  t: TFunction;
};

/** Used by SidebarContent for settings navigation and the linked source attribution. */
export default function SidebarFooter({ onShowSettings, t }: SidebarFooterProps) {
  return (
    <div className="shrink-0 border-t p-3">
      <button className="flex min-h-11 w-full items-center gap-2" onClick={onShowSettings}>
        <Settings className="h-4 w-4" />{t('actions.settings')}
      </button>
      <a
        href="https://github.com/siteboon/claudecodeui"
        target="_blank"
        rel="noopener noreferrer"
        className="flex min-h-11 items-center text-sm leading-5 text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        {t('branding.openSource')}
      </a>
    </div>
  );
}
