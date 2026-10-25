import { useI18n } from '@/i18n/context';
import { useEffect, useRef, useState } from 'react';
import { ReviewSource } from './ReviewSource';
import { ReviewItems } from './ReviewItems';
import { matchReviewItem, useReviewItems, type ReviewItem } from '../hooks/useReviewItems';
import { X, FileText, Layers, CheckSquare, Palette, Loader2 } from 'lucide-react';
import { useChange } from '../hooks/useApi';
import { useIsMobile } from '../hooks/useMediaQuery';
import type { Change } from '../types';
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

interface DetailModalProps {
  change: Change | null;
  onClose: () => void;
}

type Tab = 'proposal' | 'specs' | 'tasks' | 'design' | 'review';



const STATUS_STYLES: Record<string, string> = {
  draft: 'bg-slate-500/10 text-slate-500 border-slate-500/20',
  todo: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
  in_progress: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
  done: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
  archived: 'bg-gray-500/10 text-gray-500 border-gray-500/20',
};

export function DetailModal({ change, onClose }: DetailModalProps) {
  const { t } = useI18n();
  const TAB_CONFIG: Record<Tab, { icon: React.ReactNode; label: string; color: string }> = {
  review: { icon: <CheckSquare className="h-4 w-4" />, label: t('review.title'), color: 'text-primary' },
  proposal: { 
    icon: <FileText className="h-4 w-4" />, 
    label: t('common.proposal'),
    color: 'text-blue-500'
  },
  specs: { 
    icon: <Layers className="h-4 w-4" />, 
    label: t('common.specs'),
    color: 'text-emerald-500'
  },
  tasks: { 
    icon: <CheckSquare className="h-4 w-4" />, 
    label: t('common.tasks'),
    color: 'text-amber-500'
  },
  design: { 
    icon: <Palette className="h-4 w-4" />, 
    label: t('common.design'),
    color: 'text-purple-500'
  },
};

  const { change: detail, loading, refetch } = useChange(change?.id || null);
  const review = useReviewItems(change ? `/api/changes/${encodeURIComponent(change.id)}/review-items` : null);
  const [selection, setSelection] = useState<ReviewItem | null>(null);
  const [sourceError, setSourceError] = useState('');
  const [sourceBusy, setSourceBusy] = useState(false);
  const sourceRequest = useRef(0);
  const currentChange = useRef(change?.id); currentChange.current = change?.id;
  useEffect(() => () => { ++sourceRequest.current; }, []);
  const openSource = async (item: ReviewItem) => {
    if (sourceBusy) return;
    const id = change?.id, request = ++sourceRequest.current;
    const current = () => currentChange.current === id && request === sourceRequest.current;
    setSourceError(''); setSourceBusy(true);
    try {
      const latest = await review.refresh();
      if (!current()) return;
      const target = latest && matchReviewItem(item, latest);
      if (!target) throw new Error(t('review.changed'));
      const source = await refetch();
      if (!current()) return;
      let version = source?.documentVersions?.[target.path];
      if (source && !version) {
        const content = target.path === 'proposal.md' ? source.proposal : target.path === 'design.md' ? source.design : target.path === 'tasks.md' ? source.tasks?.raw : source.specs.find(spec => `specs/${spec.path}` === target.path)?.content;
        if (typeof content === 'string') {
          const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
          version = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        }
      }
      if (!current()) return;
      if (!source || version !== target.version) { await review.refresh(); throw new Error(t('review.changed')); }
      setSelection(target);
      setActiveTab(target.path.startsWith('specs/') ? 'specs' : target.path.replace('.md', '') as Tab);
    } catch { if (current()) setSourceError(t('review.changed')); }
    finally { if (current()) setSourceBusy(false); }
  };
  const [activeTab, setActiveTab] = useState<Tab>('proposal');
  const isMobile = useIsMobile();

  useEffect(() => {
    if (change) {
      setSelection(null); setSourceError(''); setSourceBusy(false);
      setActiveTab(
        change.hasProposal ? 'proposal' :
        change.hasSpecs ? 'specs' :
        change.hasTasks ? 'tasks' :
        change.hasDesign ? 'design' :
        'proposal'
      );
    }
  }, [change]);

  if (!change) return null;

  const availableTabs: Tab[] = [];
  if (detail ? detail.proposal !== null : change.hasProposal) availableTabs.push('proposal');
  if (detail ? detail.specs.length > 0 : change.hasSpecs) availableTabs.push('specs');
  if (detail ? detail.tasks !== null : change.hasTasks) availableTabs.push('tasks');
  if (detail ? detail.design !== null : change.hasDesign) availableTabs.push('design');
  availableTabs.push('review');

  const LoadingState = () => (
    <div className="flex flex-col items-center justify-center py-16 gap-3">
      <Loader2 className="h-8 w-8 text-primary animate-spin" />
      <div className="text-muted-foreground text-sm">{t('details.loading')}</div>
    </div>
  );

  const EmptyState = ({ message }: { message: string }) => (
    <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
      <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center">
        <FileText className="h-8 w-8 text-muted-foreground/40" />
      </div>
      <div className="text-muted-foreground">{message}</div>
    </div>
  );

  return (
    <Dialog open={!!change} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        overlayClassName="z-[79]"
        style={{ zIndex: 80 }}
        showCloseButton={!isMobile}
        className={
          isMobile
            // Full-screen on mobile
            ? "fixed inset-0 top-0 left-0 translate-x-0 translate-y-0 w-screen h-screen !max-w-none max-h-none rounded-none border-0 p-0 flex flex-col gap-0"
            // Better size on desktop
            : "!w-[85vw] !max-w-[1100px] !h-[85vh] !max-h-[85vh] flex flex-col"
        }
      >
        {/* Header */}
        <DialogHeader className={isMobile ? "p-4 border-b border-border flex-shrink-0 bg-background/95 backdrop-blur-sm" : "flex-shrink-0 px-6"}>
          <div className={isMobile ? "flex items-center justify-between gap-4" : ""}>
            <div className={isMobile ? "flex-1 min-w-0" : ""}>
              <DialogTitle className={cn(
                "leading-snug",
                isMobile ? "truncate text-left text-base" : "text-xl"
              )}>
                {change.name}
              </DialogTitle>
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                <Badge 
                  variant="secondary" 
                  className="text-xs font-medium bg-muted/80"
                >
                  {change.sourceId}
                </Badge>
                <Badge 
                  variant="outline" 
                  className={cn(
                    "text-xs capitalize font-medium",
                    STATUS_STYLES[change.status]
                  )}
                >
                  {({ draft: t('kanban.draft'), todo: t('kanban.todo'), in_progress: t('kanban.progress'), done: t('kanban.done'), archived: t('kanban.archived') })[change.status]}
                </Badge>
                {change.taskStats && change.taskStats.total > 0 && (
                  <Badge variant="outline" className="text-xs font-medium">
                    {t('common.progress', { done: change.taskStats.done, total: change.taskStats.total })}
                  </Badge>
                )}
              </div>
            </div>
            {isMobile && (
              <DialogClose asChild>
                <Button aria-label={t('common.close')} variant="ghost" size="icon" className="flex-shrink-0 h-9 w-9 rounded-lg">
                  <X className="h-4 w-4" />
                </Button>
              </DialogClose>
            )}
          </div>
        </DialogHeader>

        {/* Content */}
        <div className={`flex-1 overflow-hidden flex flex-col min-h-0 ${isMobile ? 'px-4' : 'px-6'}`}>
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as Tab)} className="flex-1 flex flex-col min-h-0 overflow-hidden">
            <TabsList 
              className="grid w-full flex-shrink-0 bg-muted/50 p-1 h-auto gap-1" 
              style={{ gridTemplateColumns: `repeat(${availableTabs.length}, 1fr)` }}
            >
              {availableTabs.map((tab) => {
                const config = TAB_CONFIG[tab];
                return (
                  <TabsTrigger 
                    key={tab}
                    value={tab} 
                    aria-label={config.label}
                    className={cn(
                      "text-xs md:text-sm py-2 px-3 rounded-md transition-all duration-200",
                      "data-[state=active]:bg-background data-[state=active]:shadow-sm",
                      "flex items-center gap-2"
                    )}
                  >
                    <span className={cn(
                      "transition-colors",
                      activeTab === tab ? config.color : "text-muted-foreground"
                    )}>
                      {config.icon}
                    </span>
                    <span className="hidden sm:inline">{config.label}</span>
                  </TabsTrigger>
                );
              })}
            </TabsList>

            <div className="flex-1 overflow-y-auto overflow-x-hidden mt-4 scroll-smooth">
              <div className="pr-2 pb-8 overflow-hidden">
                {sourceError && <p role="alert">{sourceError}</p>}
                <TabsContent value="review"><ReviewItems {...review} busy={sourceBusy} onSelect={item => void openSource(item)} /></TabsContent>
                {loading ? (
                  <LoadingState />
                ) : !detail ? (
                  <EmptyState message={t('details.error')} />
                ) : (
                  <>
                    <TabsContent value="proposal" className="mt-0 data-[state=active]:block animate-in fade-in-50 duration-200 overflow-hidden">
                      {detail.proposal ? (
                        <article className="prose prose-sm dark:prose-invert max-w-none prose-headings:font-semibold prose-a:text-primary prose-code:text-sm overflow-hidden break-words">
                          <ReviewSource content={detail.proposal} path="proposal.md" selection={selection} />
                        </article>
                      ) : (
                        <EmptyState message={t('details.noProposal')} />
                      )}
                    </TabsContent>

                    <TabsContent value="specs" className="mt-0 data-[state=active]:block animate-in fade-in-50 duration-200 overflow-hidden">
                      {detail.specs.length > 0 ? (
                        <div className="space-y-8 overflow-hidden">
                          {detail.specs.map((spec, idx) => (
                            <div key={idx} className="overflow-hidden">
                              <div className="flex items-center gap-2 mb-4 min-w-0">
                                <Layers className="h-4 w-4 text-emerald-500 flex-shrink-0" />
                                <h3 className="text-sm font-semibold font-mono text-foreground truncate">
                                  {spec.path}
                                </h3>
                              </div>
                              <article className="prose prose-sm dark:prose-invert max-w-none prose-headings:font-semibold prose-a:text-primary prose-code:text-sm overflow-hidden break-words">
                                <ReviewSource content={spec.content} path={`specs/${spec.path}`} selection={selection} />
                              </article>
                              {idx < detail.specs.length - 1 && <Separator className="my-8" />}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <EmptyState message={t('specs.none')} />
                      )}
                    </TabsContent>

                    <TabsContent value="tasks" className="mt-0 data-[state=active]:block animate-in fade-in-50 duration-200 overflow-hidden">
                      {detail.tasks ? (
                        <article className="prose prose-sm dark:prose-invert max-w-none prose-headings:font-semibold prose-a:text-primary prose-code:text-sm prose-li:marker:text-primary overflow-hidden break-words">
                          <ReviewSource content={detail.tasks.raw} path="tasks.md" selection={selection} />
                        </article>
                      ) : (
                        <EmptyState message={t('details.noTasks')} />
                      )}
                    </TabsContent>

                    <TabsContent value="design" className="mt-0 data-[state=active]:block animate-in fade-in-50 duration-200 overflow-hidden">
                      {detail.design ? (
                        <article className="prose prose-sm dark:prose-invert max-w-none prose-headings:font-semibold prose-a:text-primary prose-code:text-sm overflow-hidden break-words">
                          <ReviewSource content={detail.design} path="design.md" selection={selection} />
                        </article>
                      ) : (
                        <EmptyState message={t('details.noDesign')} />
                      )}
                    </TabsContent>
                  </>
                )}
              </div>
            </div>
          </Tabs>
        </div>
      </DialogContent>
    </Dialog>
  );
}
