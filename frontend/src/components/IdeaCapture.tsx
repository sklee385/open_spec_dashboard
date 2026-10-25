import { useI18n } from '@/i18n/context';
import { useState, useEffect } from 'react';
import { useSources } from '../hooks/useApi';
import { createIdea, updateIdea } from '../hooks/useApi';
import type { Idea } from '../types';
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface IdeaCaptureProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: React.ReactNode;
  idea?: Idea | null;
  onSuccess?: () => void;
}

export function IdeaCapture({ open: controlledOpen, onOpenChange, trigger, idea, onSuccess }: IdeaCaptureProps) {
  const { t } = useI18n();


  const [internalOpen, setInternalOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { sources } = useSources();

  const open = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const setOpen = onOpenChange || setInternalOpen;
  const isEditing = !!idea;

  useEffect(() => {
    if (idea) {
      setTitle(idea.title);
      setDescription(idea.description);
      setSourceId(idea.sourceId);
    } else {
      setTitle('');
      setDescription('');
      setSourceId(null);
    }
  }, [idea]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    setSaving(true);
    try {
      if (isEditing && idea) {
        await updateIdea(idea.id, title, description);
      } else {
        await createIdea(title, description, sourceId);
      }
      setTitle('');
      setDescription('');
      setSourceId(null);
      setOpen(false);
      onSuccess?.();
    } catch (error) {
      console.error('Failed to save idea:', error);
      alert(t('ideas.saveError'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger ? (
        <DialogTrigger asChild>
          {trigger}
        </DialogTrigger>
      ) : null}
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{isEditing ? t('ideas.edit') : t('ideas.capture')}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? t('ideas.editHint')
              : t('ideas.captureHint')
            }
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
            {!isEditing && (
              <div className="space-y-2">
                <Label htmlFor="source">{t('ideas.source')}</Label>
                <Select
                  value={sourceId || ''}
                  onValueChange={(value) => setSourceId(value === 'none' ? null : value)}
                >
                  <SelectTrigger id="source">
                    <SelectValue placeholder={t('ideas.selectSource')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t('ideas.noSource')}</SelectItem>
                    {sources.map((source) => (
                      <SelectItem key={source.id} value={source.id}>
                        {source.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="title">{t('ideas.title')}</Label>
              <Input
                id="title"
                placeholder={t('ideas.titlePlaceholder')}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={saving}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">{t('common.description')}</Label>
              <textarea
                id="description"
                placeholder={t('ideas.descriptionPlaceholder')}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={saving}
                rows={4}
                className="flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={saving}
            >
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={saving || !title.trim()}>
              {saving ? t('settings.saving') : (isEditing ? t('ideas.update') : t('ideas.save'))}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
