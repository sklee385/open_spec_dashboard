import { useI18n } from '@/i18n/context';
import { useState, useCallback, useEffect, useRef } from 'react';
import { AttentionContext, AttentionOverlays } from './components/AttentionCenter';
import { useAttention } from './hooks/useAttention';
import { consumeAttentionLink, parseAttentionLink, loadAttentionDestination, type AttentionLink, type AttentionTarget, type WorkRoomNavigation } from './lib/attentionNavigation';
import { Header } from './components/Header';
import { useAiActivity } from './hooks/useAiActivity';
import { BoardTrashContext, useBoardTrash } from './components/BoardTrash';
import { KanbanBoard } from './components/KanbanBoard';
import { SpecsView } from './components/SpecsView';
import { WorkRoom } from './components/WorkRoom';
import { ProjectWorkspace, type ProjectWorkScope } from './components/ProjectWorkspace';
import { IdeaDetailModal } from './components/IdeaDetailModal';
import { SettingsModal } from './components/SettingsModal';
import { SourceManagementModal } from './components/SourceManagementModal';
import { IdeaCapture } from './components/IdeaCapture';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useSSE, useChanges, useSpecs, useSources, useIdeas, type SourceConfig } from './hooks/useApi';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import type { Change, Idea } from './types';
import './App.css';

type View = 'kanban' | 'specs' | 'project';

const SHOW_ARCHIVED_KEY = 'openspec-show-archived';
const SELECTED_SOURCE_KEY = 'openspec-selected-source';

function App() {
  const { t } = useI18n();
  const activity = useAiActivity();
  const trash = useBoardTrash();


  const [currentView, setCurrentView] = useState<View>(() => {
    const stored = localStorage.getItem('openspec-view');
    if (stored === 'kanban' || stored === 'specs' || stored === 'project') {
      return stored;
    }
    return 'kanban';
  });
  const [initialLink] = useState(() => { try { return { target: parseAttentionLink(window.location.href), invalid: false }; } catch { return { target: null, invalid: true }; } });
  const [selectedChange, setSelectedChange] = useState<Change | null>(() => {
    if (initialLink.target || initialLink.invalid) return null;
    try { return JSON.parse(localStorage.getItem('openspec-active-change') || 'null'); } catch { return null; }
  });
  const workRoomNavigation = useRef<WorkRoomNavigation>(null);
  const projectNavigation = useRef<(() => Promise<boolean>) | null>(null);
  const [projectVisited, setProjectVisited] = useState(() => localStorage.getItem('openspec-view') === 'project');
  const [workHidden, setWorkHidden] = useState(false);
  const [workPicker, setWorkPicker] = useState(false);
  const [workScopeId, setWorkScopeId] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<ProjectWorkScope[]>([]);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const registerProjectGuard = useCallback((guard: () => Promise<boolean>) => { projectNavigation.current = guard; }, []);
  const targetToken = useRef(0);
  const [attentionTarget, setAttentionTarget] = useState<AttentionTarget>();
  const openAttention = useCallback(async (item: AttentionLink) => {
    const destination = await loadAttentionDestination(item);
    if (projectNavigation.current && !await projectNavigation.current()) return;
    if (workRoomNavigation.current && !workRoomNavigation.current.preserveDrafts()) throw new Error('Draft preservation failed');
    setSelectedIdea(null);
    setSelectedChange(destination);
    setWorkHidden(false);
    setAttentionTarget({ workId: item.workId, questionId: item.questionId, token: ++targetToken.current });
  }, []);
  const attention = useAttention(openAttention);
  const initialLinkStarted = useRef(false);
  const initialNavigation = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (initialLinkStarted.current) return; initialLinkStarted.current = true;
    if (initialLink.invalid) { attention.reportNavigationError(); return; }
    if (initialLink.target) initialNavigation.current = openAttention(initialLink.target).then(consumeAttentionLink).catch(attention.reportNavigationError);
  }, [initialLink, openAttention, attention.reportNavigationError]);
  useEffect(() => {
    const bridge = window.desktopAttention;
    if (!bridge) return;
    let stopped = false, pending = Promise.resolve();
    const unsubscribe = bridge.onRequest(target => {
      pending = pending.then(async () => {
        if (stopped) return;
        if ('invalid' in target) { attention.reportNavigationError(); return; }
        await openAttention(target);
      }).catch(() => { if (!stopped) attention.reportNavigationError(); });
    });
    void initialNavigation.current.then(() => { if (!stopped) return bridge.ready(); }).catch(() => { if (!stopped) attention.reportNavigationError(); });
    return () => { stopped = true; unsubscribe(); };
  }, [openAttention, attention.reportNavigationError]);
  const [selectedIdea, setSelectedIdea] = useState<Idea | null>(null);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(() => {
    return localStorage.getItem(SELECTED_SOURCE_KEY);
  });
  const [showArchived, setShowArchived] = useState<boolean>(() => {
    const stored = localStorage.getItem(SHOW_ARCHIVED_KEY);
    return stored === 'true';
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [sourceRevision, setSourceRevision] = useState(0);
  const sourceManagementTrigger = useRef<HTMLElement | null>(null);
  const openSources = (trigger?: HTMLElement) => {
    sourceManagementTrigger.current = trigger || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setSettingsOpen(false);
    setSourcesOpen(true);
  };
  const openSettings = () => { setSourcesOpen(false); setSettingsOpen(true); };
  const [ideaCaptureOpen, setIdeaCaptureOpen] = useState(false);
  const [editingIdea, setEditingIdea] = useState<Idea | null>(null);
  useEffect(() => { if (selectedChange) localStorage.setItem('openspec-active-change', JSON.stringify(selectedChange)); else localStorage.removeItem('openspec-active-change'); }, [selectedChange]);

  // Persist view preference
  useEffect(() => {
    localStorage.setItem('openspec-view', currentView);
  }, [currentView]);

  // Persist showArchived preference
  useEffect(() => {
    localStorage.setItem(SHOW_ARCHIVED_KEY, String(showArchived));
  }, [showArchived]);

  // Persist selected source preference
  useEffect(() => {
    if (selectedSourceId) {
      localStorage.setItem(SELECTED_SOURCE_KEY, selectedSourceId);
    } else {
      localStorage.removeItem(SELECTED_SOURCE_KEY);
    }
  }, [selectedSourceId]);

  const { sources, refetch: refetchSources } = useSources();
  const { changes, loading: changesLoading, error: changesError, refetch: refetchChanges } = useChanges();
  const { refetch: refetchSpecs } = useSpecs();
  const { ideas, loading: ideasLoading, error: ideasError, refetch: refetchIdeas } = useIdeas();
  useEffect(() => {
    if (!projectVisited || currentView !== 'project') return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetch('/api/work');
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled && Array.isArray(data.work)) setWorkspaces(data.work);
      } catch { /* Existing file navigation remains available if work listing is temporarily unavailable. */ }
    };
    void refresh(); window.addEventListener('focus', refresh);
    return () => { cancelled = true; window.removeEventListener('focus', refresh); };
  }, [projectVisited, currentView, selectedSourceId, workspaceRevision]);

  const changeView = async (view: View) => {
    if (currentView === 'project' && view !== 'project' && projectNavigation.current && !await projectNavigation.current()) return;
    if (view === 'project') setProjectVisited(true);
    setCurrentView(view);
  };
  const changeSource = async (sourceId: string | null) => {
    if (sourceId === selectedSourceId) return;
    if (projectNavigation.current && !await projectNavigation.current()) return;
    setWorkScopeId(null);
    setSelectedSourceId(sourceId);
  };
  const openProject = async (work?: { id: string; executionPath?: string }) => {
    if (!selectedChange) return;
    if (projectNavigation.current && !await projectNavigation.current()) return;
    if (workRoomNavigation.current && !workRoomNavigation.current.preserveDrafts()) return;
    if (work?.executionPath) {
      setWorkScopeId(work.id);
      setWorkspaces(current => current.some(item => item.id === work.id) ? current : [...current, { ...work, sourceId: selectedChange.sourceId, changeName: selectedChange.name, title: selectedChange.title, phase: 'implementation' }]);
    } else setWorkScopeId(null);
    setWorkspaceRevision(value => value + 1);
    setSelectedSourceId(selectedChange.sourceId); setProjectVisited(true); setCurrentView('project'); setWorkHidden(true);
  };
  const openProjectWork = async () => {
    if (projectNavigation.current && !await projectNavigation.current()) return;
    const scope = workspaces.find(work => work.id === workScopeId && work.sourceId === selectedSourceId);
    if (scope) {
      if (selectedChange?.id !== `${scope.sourceId}/${scope.changeName}`) setSelectedChange(changes.find(change => change.sourceId === scope.sourceId && change.name === scope.changeName) || { id: `${scope.sourceId}/${scope.changeName}`, sourceId: scope.sourceId, name: scope.changeName, title: scope.title, status: 'in_progress', schema: 'spec-driven', artifacts: [], hasProposal: true, hasDesign: true, hasSpecs: true, hasTasks: true, taskStats: null });
      setWorkHidden(false); return;
    }
    if (selectedChange?.sourceId === selectedSourceId) { setWorkHidden(false); return; }
    setWorkPicker(true);
  };

  // Connect to SSE for real-time updates
  const handleUpdate = useCallback(() => {
    refetchChanges();
    refetchSpecs();
    refetchSources();
    refetchIdeas();
  }, [refetchChanges, refetchSpecs, refetchSources, refetchIdeas]);

  useSSE(handleUpdate);

  const handleSourcesSaved = (saved: SourceConfig[]) => {
    setSelectedSourceId(current => current && saved.some(source => source.name === current) ? current : null);
    setSourceRevision(revision => revision + 1);
    handleUpdate();
  };

  // Keyboard shortcuts
  useKeyboardShortcuts({
    '/': () => {
      // Focus on search - this will require ref forwarding in future
      console.log('Search shortcut - implement focus on search input');
    },
    'escape': () => {
      if (selectedChange) return;
      setSelectedChange(null);
      setSettingsOpen(false);
      setSourcesOpen(false);
    },
  });

  return (
    <BoardTrashContext.Provider value={trash}><AttentionContext.Provider value={attention}><ErrorBoundary>
      <div className="min-h-screen bg-background overflow-x-hidden max-w-full">
        <Header
          aiState={activity.state}
          aiWorkingCount={activity.count}
          currentView={currentView}
          onViewChange={view => void changeView(view)}
          sources={sources}
          selectedSourceId={selectedSourceId}
          onSourceChange={sourceId => void changeSource(sourceId)}
          showArchived={showArchived}
          onShowArchivedChange={setShowArchived}
          onOpenSettings={openSettings}
          onOpenSources={openSources}
          onOpenNewIdea={() => setIdeaCaptureOpen(true)}
        />
        <AttentionOverlays sources={sources} />
        <main className={currentView === 'specs' ? "max-w-7xl mx-auto px-4 pt-4 md:pt-6" : "px-4 pt-4 md:pt-6"}>
          {currentView === 'kanban' ? (
            <KanbanBoard
              changes={changes.filter(change => !trash.entries.some(entry => entry.kind === 'change' && entry.id === change.id)).map(change => ({ ...change, workState: activity.byChange.get(change.id) }))}
              ideas={ideas.filter(idea => !trash.entries.some(entry => entry.kind === 'idea' && entry.id === idea.id))}
              sources={sources}
              loading={changesLoading || ideasLoading}
              error={changesError || ideasError}
              onCardClick={setSelectedChange}
              onIdeaClick={setSelectedIdea}
              selectedSourceId={selectedSourceId}
              showArchived={showArchived}
              onOpenSources={() => openSources()}
              onOpenNewIdea={() => setIdeaCaptureOpen(true)}
            />
          ) : currentView === 'specs' ? (
            <SpecsView selectedSourceId={selectedSourceId} refreshVersion={sourceRevision} />
          ) : null}
          {projectVisited && <div hidden={currentView !== 'project'}><ProjectWorkspace sourceId={selectedSourceId} workspaces={workspaces} workId={workScopeId} onWorkScopeChange={setWorkScopeId} active={currentView === 'project' && (!selectedChange || workHidden)} registerNavigationGuard={registerProjectGuard} onOpenWork={() => void openProjectWork()} /></div>}
        </main>
        {selectedChange && (
          <div hidden={workHidden}>
          <WorkRoom
            key={selectedChange.id}
            change={selectedChange}
            attentionTarget={attentionTarget}
            navigationRef={workRoomNavigation}
            onOpenSource={work => void openProject(work)}
            onClose={() => { setSelectedChange(null); setWorkHidden(false); setAttentionTarget(undefined); }}
          />
          </div>
        )}
        {workPicker && <div role="dialog" aria-modal="true" aria-label={t('project.selectWork')} className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4"><section className="max-h-[80vh] overflow-auto rounded-xl bg-background p-6 shadow-xl min-w-72"><h2>{t('project.selectWork')}</h2>{changes.filter(change => change.sourceId === selectedSourceId && change.status !== 'archived').map(change => <button className="block w-full text-left p-2 hover:bg-muted" key={change.id} onClick={() => { setSelectedChange(change); setWorkHidden(false); setWorkPicker(false); }}>{change.title || change.name}</button>)}{!changes.some(change => change.sourceId === selectedSourceId && change.status !== 'archived') && <p>{t('project.noWork')}</p>}<button className="block p-2" onClick={() => { setWorkPicker(false); setIdeaCaptureOpen(true); }}>{t('project.newWork')}</button><button className="p-2" onClick={() => setWorkPicker(false)}>{t('project.cancel')}</button></section></div>}
        {selectedIdea && (
          <IdeaDetailModal
            idea={selectedIdea}
            onClose={() => setSelectedIdea(null)}
            onDeleted={refetchIdeas}
            onStart={async (idea, changeName) => {
              const response = await fetch('/api/work', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceId: idea.sourceId, ideaId: idea.id, changeName, requestKey: `idea:${idea.id}:${changeName}` }) });
              const data = await response.json();
              if (!response.ok) throw new Error(data.message || data.error || t('ideas.startError'));
              setSelectedIdea(null);
              setSelectedChange({ id: `${data.sourceId}/${data.changeName}`, name: data.changeName, sourceId: data.sourceId, status: 'draft', hasProposal: false, hasDesign: false, hasSpecs: false, hasTasks: false, taskStats: null, schema: 'spec-driven', artifacts: [] });
              handleUpdate();
            }}
            onEdit={(idea) => {
              setEditingIdea(idea);
              setIdeaCaptureOpen(true);
            }}
          />
        )}
        <SettingsModal
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
        />
        <SourceManagementModal open={sourcesOpen} onOpenChange={setSourcesOpen} onSaved={handleSourcesSaved} returnFocusRef={sourceManagementTrigger} />
        <IdeaCapture
          defaultSourceId={selectedSourceId}
          open={ideaCaptureOpen}
          onOpenChange={(open) => {
            setIdeaCaptureOpen(open);
            if (!open) {
              setEditingIdea(null);
            }
          }}
          idea={editingIdea}
          onSuccess={() => {
            refetchIdeas();
            setEditingIdea(null);
          }}
        />
      </div>
    </ErrorBoundary></AttentionContext.Provider></BoardTrashContext.Provider>
  );
}

export default App;




