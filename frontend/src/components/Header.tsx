import { useI18n } from '@/i18n/context';
import { AiActivity } from './AiActivity';
import { AttentionBell } from './AttentionCenter';
import { TrashControls } from './BoardTrash';
import { useRef, useState } from 'react';
import { useTheme } from '../hooks/useTheme';
import { Menu, Settings, Sun, Moon, Sparkles, Lightbulb, FolderOpen } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetTrigger,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { Source } from '../types';

type View = 'kanban' | 'specs' | 'project';

interface HeaderProps {
  aiState?: string;
  aiWorkingCount?: number;
  currentView: View;
  onViewChange: (view: View) => void;
  sources: Source[];
  selectedSourceId: string | null;
  onSourceChange: (id: string | null) => void;
  showViewToggle?: boolean;
  showArchived?: boolean;
  onShowArchivedChange?: (show: boolean) => void;
  onOpenSettings?: () => void;
  onOpenSources?: (trigger: HTMLElement) => void;
  onOpenNewIdea?: () => void;
}

export function Header({
  aiState,
  aiWorkingCount,
  currentView,
  onViewChange,
  sources,
  selectedSourceId,
  onSourceChange,
  showViewToggle = true,
  showArchived = false,
  onShowArchivedChange,
  onOpenSettings,
  onOpenSources,
  onOpenNewIdea,
}: HeaderProps) {
  const { t } = useI18n();


  const { theme, toggle } = useTheme();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileMenuTrigger = useRef<HTMLButtonElement | null>(null);

  const handleOpenSettings = () => {
    setMobileMenuOpen(false);
    onOpenSettings?.();
  };

  const Logo = () => (
    <div className="flex items-center gap-2.5 group cursor-default select-none shrink-0">
      <img src="/openspecboard-icon.svg" alt="" width={32} height={32} className="rounded-lg shadow-sm" />
      <span className="text-lg font-bold tracking-tight whitespace-nowrap">
        <span className="text-foreground">OpenSpecBoard</span>
      </span>
    </div>
  );

  const ViewToggle = ({ mobile = false }: { mobile?: boolean }) => {
    const handleViewChange = (view: View) => {
      onViewChange(view);
      if (mobile) {
        setMobileMenuOpen(false);
      }
    };

    if (mobile) {
      return (
        <div className="space-y-1">
          <button
            onClick={() => handleViewChange('kanban')}
            className={cn(
              "flex items-center w-full px-3 py-2.5 text-sm rounded-lg transition-all duration-200",
              currentView === 'kanban'
                ? "bg-primary text-primary-foreground font-medium shadow-sm"
                : "text-foreground hover:bg-muted"
            )}
          >
            <span className="mr-3">📋</span>
            {t('header.kanbanBoard')}
          </button>
          <button
            onClick={() => handleViewChange('specs')}
            className={cn(
              "flex items-center w-full px-3 py-2.5 text-sm rounded-lg transition-all duration-200",
              currentView === 'specs'
                ? "bg-primary text-primary-foreground font-medium shadow-sm"
                : "text-foreground hover:bg-muted"
            )}
          >
            <span className="mr-3">📄</span>
            {t('header.specifications')}
          </button>
          <button onClick={() => handleViewChange('project')} className={cn('flex items-center w-full px-3 py-2.5 text-sm rounded-lg', currentView === 'project' ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-muted')}>{t('project.title')}</button>
        </div>
      );
    }

    return (
      <nav className="flex p-1 bg-muted/50 rounded-lg gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => handleViewChange('kanban')}
          className={cn(
            "h-8 px-3 rounded-md transition-all duration-200",
            currentView === 'kanban'
              ? "bg-background text-foreground shadow-sm font-medium"
              : "text-muted-foreground hover:text-foreground hover:bg-transparent"
          )}
        >
          {t('header.kanban')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => handleViewChange('specs')}
          className={cn(
            "h-8 px-3 rounded-md transition-all duration-200",
            currentView === 'specs'
              ? "bg-background text-foreground shadow-sm font-medium"
              : "text-muted-foreground hover:text-foreground hover:bg-transparent"
          )}
        >
          {t('common.specs')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => handleViewChange('project')} className={cn('h-8 px-3 rounded-md', currentView === 'project' ? 'bg-background text-foreground shadow-sm font-medium' : 'text-muted-foreground')}>{t('project.title')}</Button>
      </nav>
    );
  };

  const SourceSelect = () => (
    <Select
      value={selectedSourceId || "all"}
      onValueChange={(val) => onSourceChange(val === "all" ? null : val)}
    >
      <SelectTrigger className="w-[160px] md:w-[180px] h-9 text-sm bg-background/50 border-border/50 hover:border-border transition-colors shrink-0">
        <SelectValue placeholder={t('header.allProjects')} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">
          <span className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-gradient-to-r from-[var(--accent-violet)] to-[var(--accent-cyan)] shrink-0" />
            <span className="truncate">{t('header.allProjects')}</span>
          </span>
        </SelectItem>
        {sources.map(s => (
          <SelectItem key={s.id} value={s.id}>
            <span className="flex items-center gap-2 min-w-0">
              <span className="w-2 h-2 rounded-full bg-[var(--accent-emerald)] shrink-0" />
              <span className="truncate">{s.name}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  const ThemeToggle = ({ mobile = false }: { mobile?: boolean }) => {
    if (mobile) {
      return (
        <button
          onClick={toggle}
          className="flex items-center gap-3 w-full px-3 py-2.5 text-sm rounded-lg text-foreground hover:bg-muted transition-all duration-200"
          aria-label={t('header.theme')}
        >
          {theme === 'dark' ? (
            <>
              <Sun className="h-4 w-4 text-amber-500" />
              {t('header.light')}
            </>
          ) : (
            <>
              <Moon className="h-4 w-4 text-indigo-500" />
              {t('header.dark')}
            </>
          )}
        </button>
      );
    }

    return (
      <Button 
        variant="ghost" 
        size="icon" 
        onClick={toggle} 
        aria-label={t('header.theme')}
        className="h-9 w-9 rounded-lg hover:bg-muted transition-colors"
      >
        {theme === 'dark' ? (
          <Sun className="h-4 w-4 text-amber-500 transition-transform hover:rotate-45" />
        ) : (
          <Moon className="h-4 w-4 text-indigo-500 transition-transform hover:-rotate-12" />
        )}
      </Button>
    );
  };

  const SettingsButton = ({ mobile = false }: { mobile?: boolean }) => {
    if (mobile) {
      return (
        <button
          onClick={handleOpenSettings}
          className="flex items-center gap-3 w-full px-3 py-2.5 text-sm rounded-lg text-foreground hover:bg-muted transition-all duration-200"
          aria-label={t('header.settings')}
        >
          <Settings className="h-4 w-4" />
          {t('common.settings')}
        </button>
      );
    }

    return (
      <Button 
        variant="ghost" 
        size="icon" 
        onClick={handleOpenSettings} 
        aria-label={t('header.settings')}
        className="h-9 w-9 rounded-lg hover:bg-muted transition-colors"
      >
        <Settings className="h-4 w-4 transition-transform hover:rotate-90 duration-300" />
      </Button>
    );
  };

  // Render directly so the trigger element survives Header updates and can regain focus.
  const sourcesButton = (mobile = false) => (
    <Button
      variant="ghost"
      size={mobile ? 'default' : 'sm'}
      className={mobile ? 'w-full justify-start gap-3 px-3' : 'h-9 gap-2'}
      aria-label={t('sources.open')}
      data-source-management-trigger={mobile ? undefined : true}
      onClick={event => {
        const trigger = mobile ? mobileMenuTrigger.current : event.currentTarget;
        setMobileMenuOpen(false);
        if (trigger) onOpenSources?.(trigger);
      }}
    >
      <FolderOpen className="h-4 w-4" />{t('sources.title')}
    </Button>
  );

  const NewIdeaButton = ({ mobile = false }: { mobile?: boolean }) => {
    if (mobile) {
      return (
        <button
          onClick={() => {
            onOpenNewIdea?.();
            setMobileMenuOpen(false);
          }}
          className="flex items-center gap-3 w-full px-3 py-2.5 text-sm rounded-lg text-foreground hover:bg-muted transition-all duration-200"
          aria-label={t('header.createIdea')}
        >
          <Lightbulb className="h-4 w-4" />
          {t('header.newIdea')}
        </button>
      );
    }

    return (
      <Button
        variant="default"
        size="sm"
        onClick={onOpenNewIdea}
        className="h-9"
      >
        <Lightbulb className="h-4 w-4 mr-2" />
        {t('header.newIdea')}
      </Button>
    );
  };

  const ShowArchivedToggle = ({ mobile = false }: { mobile?: boolean }) => {
    if (currentView !== 'kanban' || !onShowArchivedChange) {
      return null;
    }

    const handleToggle = () => {
      onShowArchivedChange(!showArchived);
      if (mobile) {
        setMobileMenuOpen(false);
      }
    };

    if (mobile) {
      return (
        <button
          onClick={handleToggle}
          className={cn(
            "flex items-center w-full px-3 py-2.5 text-sm rounded-lg transition-all duration-200",
            showArchived
              ? "bg-primary text-primary-foreground font-medium shadow-sm"
              : "text-foreground hover:bg-muted"
          )}
          aria-label={t('header.toggleArchived')}
        >
          <span className="mr-3">📦</span>
          {showArchived ? t('header.hideArchived') : t('header.showArchived')}
        </button>
      );
    }

    return (
      <Button
        variant={showArchived ? 'default' : 'outline'}
        size="sm"
        onClick={handleToggle}
        aria-label={t('header.toggleArchived')}
        className={cn(
          "h-9 transition-all duration-200",
          !showArchived && "bg-background/50 border-border/50 hover:border-border"
        )}
      >
        {showArchived ? t('header.hideArchived') : t('header.showArchived')}
      </Button>
    );
  };

  return (
    <header className="sticky top-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-xl supports-[backdrop-filter]:bg-background/60 overflow-x-hidden">
      <div className="w-full px-4 overflow-hidden">
        <div className="flex flex-col">
          {/* Left: Logo + Desktop Nav */}
          <div className="flex items-center gap-4 md:gap-6 min-w-0 min-h-16 flex-wrap py-2">
            <Logo />
            <AiActivity state={aiState} count={aiWorkingCount} />
            {/* Desktop view toggle */}
            {showViewToggle && (
              <div className="hidden md:block">
                <ViewToggle />
              </div>
            )}
          </div>

          {/* Second row: project and workspace controls */}
          <div className="flex items-center justify-end flex-wrap gap-2 md:gap-3 pb-3">
            <AttentionBell />
            <TrashControls />
            {/* Show Archived toggle - visible on desktop when in kanban view */}
            <div className="hidden md:block">
              <ShowArchivedToggle />
            </div>

            {/* Source select - visible on all sizes */}
            <SourceSelect />

            {/* New Idea button - visible on desktop */}
            <div className="hidden md:block">
              {currentView !== 'kanban' && <NewIdeaButton />}
            </div>

            {/* Settings button - visible on desktop */}
            <div className="hidden md:block">{sourcesButton()}</div>
            <div className="hidden md:block">
              <SettingsButton />
            </div>

            {/* Theme toggle - visible on desktop */}
            <div className="hidden md:block">
              <ThemeToggle />
            </div>

            {/* Mobile menu */}
            <div className="md:hidden">
              <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
                <SheetTrigger asChild>
                  <Button ref={mobileMenuTrigger} data-mobile-menu-trigger variant="ghost" size="icon" aria-label={t('header.openMenu')} className="h-9 w-9">
                    <Menu className="h-5 w-5" />
                  </Button>
                </SheetTrigger>
                <SheetContent side="right" className="w-[300px] p-0">
                  <div className="flex flex-col h-full">
                    <SheetHeader className="px-5 py-5 border-b border-border">
                      <SheetTitle className="text-left flex items-center gap-2">
                        <Sparkles className="h-4 w-4 text-primary" />
                        {t('header.menu')}
                      </SheetTitle>
                    </SheetHeader>
                    <nav className="flex-1 px-4 py-5 space-y-6">
                      {showViewToggle && (
                        <div className="space-y-2">
                          <p className="px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t('header.view')}</p>
                          <ViewToggle mobile />
                        </div>
                      )}
                      {currentView === 'kanban' && onShowArchivedChange && (
                        <div className="space-y-2">
                          <p className="px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t('header.filter')}</p>
                          <ShowArchivedToggle mobile />
                        </div>
                      )}
                      <div className="space-y-2">
                        <p className="px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t('header.preferences')}</p>
                        <div className="space-y-1">
                          {currentView !== 'kanban' && <NewIdeaButton mobile />}
                          {sourcesButton(true)}
                          <SettingsButton mobile />
                          <ThemeToggle mobile />
                        </div>
                      </div>
                    </nav>
                  </div>
                </SheetContent>
              </Sheet>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
