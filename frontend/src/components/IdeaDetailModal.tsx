import { useI18n } from '@/i18n/context';
import { useState } from 'react';
import { X, Lightbulb, Calendar, Folder, Trash2, Loader2, Edit } from 'lucide-react';
import { deleteIdea } from '../hooks/useApi';
import { useIsMobile } from '../hooks/useMediaQuery';
import type { Idea } from '../types';
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatRelativeTime, formatDateTime } from "@/lib/utils";

interface IdeaDetailModalProps {
  idea: Idea | null;
  onClose: () => void;
  onDeleted?: () => void;
  onEdit?: (idea: Idea) => void;
  onStart?: (idea: Idea, changeName: string) => Promise<void>;
}

export function IdeaDetailModal({ idea, onClose, onDeleted, onEdit, onStart }: IdeaDetailModalProps) {
  const { t, locale } = useI18n();


  const [deleting, setDeleting] = useState(false);
  const [changeName, setChangeName] = useState(() => `idea-${Date.now()}`);
  const [starting, setStarting] = useState(false), [startError, setStartError] = useState('');
  const isMobile = useIsMobile();

  const handleDelete = async () => {
    if (!idea || !confirm(t('ideas.deleteConfirm'))) return;

    setDeleting(true);
    try {
      await deleteIdea(idea.id);
      onDeleted?.();
      onClose();
    } catch (error) {
      console.error('Failed to delete idea:', error);
      alert(t('ideas.deleteError'));
    } finally {
      setDeleting(false);
    }
  };

  const handleEdit = () => {
    if (idea) {
      onEdit?.(idea);
      onClose();
    }
  };

  if (!idea) return null;

  return (
    <Dialog open={!!idea} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={!isMobile}
        className={
          isMobile
            ? "fixed inset-0 top-0 left-0 translate-x-0 translate-y-0 w-screen h-screen !max-w-none max-h-none rounded-none border-0 p-0 flex flex-col gap-0"
            : "!w-[85vw] !max-w-[700px] !max-h-[85vh] flex flex-col"
        }
      >
        {/* Header */}
        <DialogHeader className={isMobile ? "p-4 border-b border-border flex-shrink-0 bg-background/95 backdrop-blur-sm" : "flex-shrink-0 px-6"}>
          <div className={isMobile ? "flex items-center justify-between gap-4" : ""}>
            <div className={isMobile ? "flex-1 min-w-0" : "flex-1"}>
              <div className="flex items-center gap-2 mb-2">
                <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500/10 to-violet-500/5 flex items-center justify-center">
                  <Lightbulb className="h-4 w-4 text-violet-600 dark:text-violet-400" />
                </div>
                <span className="text-xs font-medium text-muted-foreground">{t('ideas.idea')}</span>
              </div>
              <DialogTitle className={cn(
                "leading-snug",
                isMobile ? "truncate text-left text-base" : "text-xl"
              )}>
                {idea.title}
              </DialogTitle>
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                <Badge 
                  variant="secondary" 
                  className="text-xs font-medium bg-muted/80"
                >
                  {idea.sourceId}
                </Badge>
                <div className="flex items-center gap-1 text-xs text-muted-foreground/70">
                  <Calendar className="h-3 w-3" />
                  <span>{formatRelativeTime(idea.createdAt, locale)}</span>
                </div>
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
        <div className={`flex-1 overflow-y-auto ${isMobile ? 'px-4' : 'px-6'}`}>
          <div className="py-6 space-y-6">
            {idea.projectId && (
              <div className="flex items-center gap-2 text-sm">
                <Folder className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">{t('ideas.project')}</span>
                <Badge variant="outline" className="text-xs">
                  {idea.projectId}
                </Badge>
              </div>
            )}

            <div className="space-y-2">
              <h3 className="text-sm font-medium text-foreground">{t('common.description')}</h3>
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <p className={cn(
                  "text-sm leading-relaxed",
                  idea.description ? "text-muted-foreground" : "text-muted-foreground italic"
                )}>
                  {idea.description || t('ideas.noDescriptionDetail')}
                </p>
              </div>
            </div>

            <div className="pt-4 border-t border-border/50">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Calendar className="h-3 w-3" />
                <span>{t('ideas.created')} {formatDateTime(idea.createdAt, locale)}</span>
                {idea.updatedAt !== idea.createdAt && (
                  <>
                    <span className="text-border">•</span>
                    <span>{t('ideas.updated')} {formatDateTime(idea.updatedAt, locale)}</span>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className={cn(
          "flex-shrink-0 border-t border-border bg-background/50",
          isMobile ? "p-4" : "px-6 py-4"
        )}>
          {onStart && <form className="mb-4 flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); setStarting(true); setStartError(''); void onStart(idea, changeName).catch(error => setStartError(error.message)).finally(() => setStarting(false)); }}>
            <label>{t('ideas.changeName')}<input className="ml-2 border rounded px-2 py-1" aria-label={t('ideas.changeName')} pattern="[a-z0-9]+(-[a-z0-9]+)*" required value={changeName} onChange={event => setChangeName(event.target.value)} /></label>
            <Button type="submit" disabled={starting}>{t('ideas.startWork')}</Button>
            {startError && <p role="alert">{startError}</p>}
          </form>}
          <div className="flex gap-2 justify-end">
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDelete}
              disabled={deleting}
              className="gap-2"
            >
              {deleting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('ideas.deleting')}
                </>
              ) : (
                <>
                  <Trash2 className="h-4 w-4" />
                  {t('common.delete')}
                </>
              )}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleEdit}
              className="gap-2"
            >
              <Edit className="h-4 w-4" />
              {t('common.edit')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
