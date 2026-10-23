import { Settings, PanelLeftOpen } from 'lucide-react';
import type { TFunction } from 'i18next';
type SidebarCollapsedProps = {
  onExpand: () => void;
  onShowSettings: () => void;

  t: TFunction;
};

/** Used by Sidebar to expose navigation and settings in its collapsed rail. */
export default function SidebarCollapsed({ onExpand, onShowSettings, t }: SidebarCollapsedProps) {
 return <div className="flex h-full w-12 flex-col items-center py-3"><button className="min-h-11" onClick={onExpand} aria-label="Show sessions"><PanelLeftOpen /></button><button className="min-h-11" onClick={onShowSettings} aria-label={t('actions.settings')}><Settings /></button></div>;
}
