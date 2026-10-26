import { useI18n } from '@/i18n/context';
import { DeleteBoardItem } from './BoardTrash';
import { cn } from '@/lib/utils';
import type { Idea } from '../types';
import { formatRelativeTime } from '@/lib/utils';

interface IdeaCardProps {
  idea: Idea;
  onClick?: () => void;
}

export function IdeaCard({ idea, onClick }: IdeaCardProps) {
  const { t, locale } = useI18n();


  return (
    <div className="relative"><div className="absolute right-2 top-2 z-10"><DeleteBoardItem id={idea.id} kind="idea" /></div><button
      onClick={onClick}
      className={cn(
        "w-full text-left p-4 rounded-lg border border-border/50 bg-card hover:border-border hover:shadow-sm transition-all duration-200 group"
      )}
    >
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500/10 to-violet-500/5 flex items-center justify-center">
          <span className="text-violet-600 dark:text-violet-400">💡</span>
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium text-foreground mb-1 pr-6 whitespace-normal break-words [overflow-wrap:anywhere] group-hover:text-primary transition-colors">
            {idea.title}
          </h3>
          <p className="text-xs text-muted-foreground/70 line-clamp-2 mb-2">
            {idea.description || t('ideas.noDescription')}
          </p>
          <div className="flex items-center gap-2 text-xs text-muted-foreground/50">
            {idea.projectId && (
              <span className="px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-600 dark:text-violet-400 font-medium">
                {t('ideas.linked')}
              </span>
            )}
            <span>{formatRelativeTime(idea.createdAt, locale)}</span>
          </div>
        </div>
      </div>
    </button></div>
  );
}
