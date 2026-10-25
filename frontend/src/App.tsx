import { useI18n } from '@/i18n/context';
import { useState, useCallback, useEffect, useRef } from 'react';
import { AttentionContext, AttentionOverlays } from './components/AttentionCenter';
import { useAttention } from './hooks/useAttention';
import { consumeAttentionLink, parseAttentionLink, loadAttentionDestination, type AttentionLink, type AttentionTarget, type WorkRoomNavigation } from './lib/attentionNavigation';
import { Header } from './components/Header';
import { KanbanBoard } from './components/KanbanBoard';
import { SpecsView } from './components/SpecsView';
import { WorkRoom } from './components/WorkRoom';
import { IdeaDetailModal } from './components/IdeaDetailModal';
import { SettingsModal } from './components/SettingsModal';
import { IdeaCapture } from './components/IdeaCapture';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useSSE, useChanges, useSpecs, useSources, useIdeas } from './hooks/useApi';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import type { Change, Idea } from './types';
import './App.css';

type View = 'kanban' | 'specs';

const SHOW_ARCHIVED_KEY = 'openspec-show-archived';
const SELECTED_SOURCE_KEY = 'openspec-selected-source';

function App() {
  const { t } = useI18n();


  const [currentView, setCurrentView] = useState<View>(() => {
    const stored = localStorage.getItem('openspec-view');
    if (stored === 'kanban' || stored === 'specs') {
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
  const targetToken = useRef(0);
  const [attentionTarget, setAttentionTarget] = useState<AttentionTarget>();
  const openAttention = useCallback(async (item: AttentionLink) => {
    const destination = await loadAttentionDestination(item);
    if (workRoomNavigation.current && !workRoomNavigation.current.preserveDrafts()) throw new Error('Draft preservation failed');
    setSelectedIdea(null);
    setSelectedChange(destination);
    setAttentionTarget({ workId: item.workId, questionId: item.questionId, token: ++targetToken.current });
  }, []);
  const attention = useAttention(openAttention);
  const initialLinkStarted = useRef(false);
  useEffect(() => {
    if (initialLinkStarted.current) return; initialLinkStarted.current = true;
    if (initialLink.invalid) { attention.reportNavigationError(); return; }
    if (initialLink.target) void openAttention(initialLink.target).then(consumeAttentionLink).catch(attention.reportNavigationError);
  }, [initialLink, openAttention, attention.reportNavigationError]);
  const [selectedIdea, setSelectedIdea] = useState<Idea | null>(null);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(() => {
    return localStorage.getItem(SELECTED_SOURCE_KEY);
  });
  const [showArchived, setShowArchived] = useState<boolean>(() => {
    const stored = localStorage.getItem(SHOW_ARCHIVED_KEY);
    return stored === 'true';
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
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

  // Connect to SSE for real-time updates
  const handleUpdate = useCallback(() => {
    refetchChanges();
    refetchSpecs();
    refetchSources();
    refetchIdeas();
  }, [refetchChanges, refetchSpecs, refetchSources, refetchIdeas]);

  useSSE(handleUpdate);

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
    },
  });

  return (
    <AttentionContext.Provider value={attention}><ErrorBoundary>
      <div className="min-h-screen bg-background overflow-x-hidden max-w-full">
        <Header
          currentView={currentView}
          onViewChange={setCurrentView}
          sources={sources}
          selectedSourceId={selectedSourceId}
          onSourceChange={setSelectedSourceId}
          showArchived={showArchived}
          onShowArchivedChange={setShowArchived}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenNewIdea={() => setIdeaCaptureOpen(true)}
        />
        <AttentionOverlays sources={sources} />
        <main className={currentView === 'kanban' ? "px-4 pt-4 md:pt-6" : "max-w-7xl mx-auto px-4 pt-4 md:pt-6"}>
          {currentView === 'kanban' ? (
            <KanbanBoard
              changes={changes}
              ideas={ideas}
              sources={sources}
              loading={changesLoading || ideasLoading}
              error={changesError || ideasError}
              onCardClick={setSelectedChange}
              onIdeaClick={setSelectedIdea}
              selectedSourceId={selectedSourceId}
              showArchived={showArchived}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          ) : (
            <SpecsView selectedSourceId={selectedSourceId} />
          )}
        </main>
        {selectedChange && (
          <WorkRoom
            key={selectedChange.id}
            change={selectedChange}
            attentionTarget={attentionTarget}
            navigationRef={workRoomNavigation}
            onClose={() => { setSelectedChange(null); setAttentionTarget(undefined); }}
          />
        )}
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
        <IdeaCapture
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
    </ErrorBoundary></AttentionContext.Provider>
  );
}

export default App;




