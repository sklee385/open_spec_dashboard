import { useI18n } from '@/i18n/context';

const buildVersion = typeof __APP_VERSION__ === 'undefined' ? null : __APP_VERSION__;

export function AppVersion({ version = buildVersion }: { version?: string | null }) {
  const { t } = useI18n();
  const value = version?.trim();
  return (
    <span aria-label={t('header.appVersion')} className="text-xs text-muted-foreground whitespace-nowrap">
      {value ? `v${value}` : t('header.versionUnavailable')}
    </span>
  );
}
