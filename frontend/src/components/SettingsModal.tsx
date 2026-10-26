import { useI18n } from '@/i18n/context';
import { Settings } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AiToolSettings } from './AiToolSettings';
import { EdgeConnection } from './EdgeConnection';

interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsModal({ open, onOpenChange }: SettingsModalProps) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Settings className="h-5 w-5 text-primary" />{t('common.settings')}</DialogTitle>
        </DialogHeader>
        <div className="py-4"><AiToolSettings /><EdgeConnection /></div>
      </DialogContent>
    </Dialog>
  );
}
