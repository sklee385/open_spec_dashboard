import { useEffect, useRef, useState, type RefObject } from 'react';
import { useI18n } from '@/i18n/context';
import { ProductError, errorMessage } from '@/i18n/errors';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Plus, Trash2, AlertCircle, FolderOpen, Loader2, Check } from 'lucide-react';
import { getConfig, updateSources, type SourceConfig, type ConfigResponse } from '../hooks/useApi';
import { cn } from '@/lib/utils';

interface SourceManagementModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (sources: SourceConfig[]) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

export function SourceManagementModal({ open, onOpenChange, onSaved, returnFocusRef }: SourceManagementModalProps) {
  const { t } = useI18n();
  const [sources, setSources] = useState<SourceConfig[]>([]);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [recoveryError, setRecoveryError] = useState<Error | null>(null);
  const [success, setSuccess] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPath, setNewPath] = useState('');
  const epoch = useRef(0);
  const saving = useRef<Promise<ConfigResponse> | null>(null);

  useEffect(() => {
    if (!open) return;
    const token = ++epoch.current;
    setSuccess(false);
    setError(null);
    setRecoveryError(null);
    void loadConfig(token);
    return () => { ++epoch.current; };
  }, [open]);

  useEffect(() => {
    if (!success) return;
    const timer = setTimeout(() => setSuccess(false), 2000);
    return () => clearTimeout(timer);
  }, [success]);

  async function loadConfig(token: number, preserveError = false) {
    setLoading(true);
    setReady(false);
    setRecoveryError(null);
    try {
      // A reopened window must read after an earlier save has settled.
      if (saving.current) await saving.current.catch(() => {});
      const config = await getConfig();
      if (token !== epoch.current) return;
      setSources(config.sources);
      setReady(true);
      if (!preserveError) setError(null);
    } catch (cause) {
      if (token !== epoch.current) return;
      const failure = cause instanceof Error ? cause : new ProductError('sources.loadError');
      if (preserveError) setRecoveryError(failure);
      else setError(failure);
    } finally {
      if (token === epoch.current) setLoading(false);
    }
  }

  async function save(updatedSources: SourceConfig[], added?: SourceConfig) {
    if (saving.current || loading || !ready) return;
    const token = epoch.current;
    setLoading(true);
    setSuccess(false);
    setError(null);
    setRecoveryError(null);
    const request = updateSources(updatedSources);
    saving.current = request;
    try {
      const config = await request;
      onSaved?.(config.sources);
      if (token !== epoch.current) return;
      setSources(config.sources);
      if (added && !config.sources.some(source => source.name === added.name && source.path === added.path)) {
        setError(new ProductError('sources.notRegistered'));
      } else {
        setSuccess(true);
        if (added) { setNewName(''); setNewPath(''); }
      }
    } catch (cause) {
      if (token !== epoch.current) return;
      setError(cause instanceof Error ? cause : new ProductError('sources.updateError'));
      await loadConfig(token, true);
    } finally {
      if (saving.current === request) saving.current = null;
      if (token === epoch.current) setLoading(false);
    }
  }

  function handleAddSource() {
    if (!newName.trim() || !newPath.trim()) return;
    const added = { name: newName.trim(), path: newPath.trim() };
    void save([...sources, added], added);
  }

  function handleRemoveSource(index: number) {
    void save(sources.filter((_, i) => i !== index));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto" onCloseAutoFocus={event => {
        if (!returnFocusRef) return;
        const trigger = returnFocusRef.current;
        const target = trigger?.isConnected ? trigger : document.querySelector<HTMLElement>(
          window.matchMedia('(min-width: 768px)').matches ? '[data-source-management-trigger]' : '[data-mobile-menu-trigger]',
        );
        if (target) { event.preventDefault(); target.focus(); }
      }}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><FolderOpen className="h-5 w-5 text-primary" />{t('sources.title')}</DialogTitle>
          <DialogDescription className="sr-only">{t('sources.hint')}</DialogDescription>
        </DialogHeader>
        <div className="min-w-0 py-4">
          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-semibold leading-none">{t('sources.sources')}</h3>
              <p className="text-sm text-muted-foreground mt-1.5">
                {t('sources.hint')}
              </p>
            </div>

            {error && (
              <div role="alert" className="flex items-start gap-3 p-4 text-sm border border-destructive/50 bg-destructive/5 rounded-lg">
                <AlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                  <div className="font-medium text-destructive">{t('common.error')}</div>
                  <div className="text-muted-foreground mt-0.5">{errorMessage(error, t)}{recoveryError && <p>{errorMessage(recoveryError, t)}</p>}</div>{!ready && <Button disabled={loading} onClick={() => void loadConfig(epoch.current)}>{t('common.retry')}</Button>}
                </div>
              </div>
            )}

            {success && (
              <div role="status" className="flex items-center gap-2 p-3 text-sm border border-emerald-500/50 bg-emerald-500/5 rounded-lg text-emerald-600 dark:text-emerald-400">
                <Check className="h-4 w-4" />
                <span className="font-medium">{t('sources.saved')}</span>
              </div>
            )}

            {/* Source list */}
            <div className="border border-border/50 rounded-xl overflow-hidden bg-card/50">
              {loading && !ready ? <p role="status" className="p-4 text-sm">{t('sources.loading')}</p> : sources.length > 0 ? (
                <div className="divide-y divide-border/50">
                  {sources.map((source, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between gap-3 p-4 hover:bg-muted/30 transition-colors"
                    >
                      <div className="grid flex-1 gap-1 min-w-0">
                        <div className="font-medium flex items-center gap-2">
                          <span className="w-2 h-2 shrink-0 rounded-full bg-[var(--accent-emerald)]" />
                          <span className="min-w-0 [overflow-wrap:anywhere]">{source.name}</span>
                        </div>
                        <div className="text-xs text-muted-foreground font-mono truncate max-w-[300px] sm:max-w-[400px]">
                          {source.path}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('sources.removeNamed', { name: source.name })}
                        onClick={() => handleRemoveSource(i)}
                        disabled={loading || !ready}
                        className="text-destructive hover:text-destructive hover:bg-destructive/10 h-8 w-8 rounded-lg shrink-0"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-8 text-center">
                  <div className="w-12 h-12 rounded-xl bg-muted/50 flex items-center justify-center mx-auto mb-3">
                    <FolderOpen className="h-6 w-6 text-muted-foreground/50" />
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {t('sources.noSources')}
                  </div>
                  <p className="text-xs text-muted-foreground/70 mt-1">
                    {t('sources.addHint')}
                  </p>
                </div>
              )}
            </div>

            {/* Add new source form */}
            <div className="grid min-w-0 gap-4 p-4 border border-border/50 rounded-xl bg-muted/30">
              <div className="text-sm font-medium flex items-center gap-2">
                <Plus className="h-4 w-4 text-primary" />
                {t('sources.newSource')}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="min-w-0 space-y-2">
                  <Label htmlFor="name" className="text-xs">{t('sources.name')}</Label>
                  <Input
                    id="name"
                    placeholder={t('sources.nameExample')}
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    disabled={loading || !ready}
                    className="min-w-0 h-9 bg-background/50"
                  />
                </div>
                <div className="min-w-0 space-y-2">
                  <Label htmlFor="path" className="text-xs">{t('sources.path')}</Label>
                  <Input
                    id="path"
                    placeholder={t('sources.pathExample')}
                    value={newPath}
                    onChange={(e) => setNewPath(e.target.value)}
                    disabled={loading || !ready}
                    className="min-w-0 h-9 bg-background/50 font-mono text-sm"
                  />
                </div>
              </div>
              <Button
                onClick={handleAddSource}
                disabled={!newName.trim() || !newPath.trim() || loading || !ready}
                className={cn(
                  "w-full sm:w-auto sm:ml-auto transition-all",
                  loading && "opacity-70"
                )}
              >
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t('sources.saving')}
                  </>
                ) : (
                  <>
                    <Plus className="mr-2 h-4 w-4" />
                    {t('sources.add')}
                  </>
                )}
              </Button>
            </div>
          </div>

        </div>
      </DialogContent>
    </Dialog>
  );
}
