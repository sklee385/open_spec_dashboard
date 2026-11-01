import { useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';
import { useI18n } from '../i18n/context';

export function QuestionPanel({ title, children, actions, panelRef }: { title: string; children: ReactNode; actions: ReactNode; panelRef?: Ref<HTMLDivElement> }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false), opener = useRef<HTMLButtonElement>(null), wasExpanded = useRef(false);
  useLayoutEffect(() => {
    if (wasExpanded.current && !expanded) opener.current?.focus();
    wasExpanded.current = expanded;
  }, [expanded]);
  const body = <><div className="work-question-body">{children}</div><div className="work-question-actions">{actions}</div></>;
  if (expanded) return <Dialog open onOpenChange={setExpanded}>
    <DialogContent className="work-question-dialog" overlayClassName="work-question-overlay" showCloseButton={false} aria-describedby={undefined} onCloseAutoFocus={event => event.preventDefault()}>
      <DialogHeader className="work-question-heading"><DialogTitle>{title}</DialogTitle><DialogClose asChild><button type="button">{t('workRoom.shrinkQuestion')}</button></DialogClose></DialogHeader>
      {body}
    </DialogContent>
  </Dialog>;
  return <div className="work-question" tabIndex={-1} ref={panelRef}>
    <div className="work-question-heading"><h3>{title}</h3><button type="button" ref={opener} aria-haspopup="dialog" onClick={() => setExpanded(true)}>{t('workRoom.expandQuestion')}</button></div>
    {body}
  </div>;
}
