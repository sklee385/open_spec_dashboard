import { useState } from 'react';
import { cleanup,fireEvent,screen } from '@testing-library/react';
import { afterEach,expect,it,vi } from 'vitest';
import { render } from '../test/render';
import { QuestionPanel } from './QuestionPanel';
afterEach(cleanup);
it('keeps a single controlled answer when expanding and shrinking and returns focus to its opener',async()=>{
 function Fixture(){const [value,setValue]=useState('retained draft');return <QuestionPanel title="긴 확인 질문" actions={<button>답변 전송</button>}><textarea aria-label="답변" value={value} onChange={event=>setValue(event.target.value)}/></QuestionPanel>;}
 render(<Fixture/>);fireEvent.click(screen.getByRole('button',{name:'크게 보기'}));
 const dialog=screen.getByRole('dialog',{name:'긴 확인 질문'});expect(dialog).toBeVisible();expect(screen.getAllByRole('textbox',{name:'답변'})).toHaveLength(1);
 fireEvent.change(screen.getByRole('textbox',{name:'답변'}),{target:{value:'expanded draft'}});
 fireEvent.click(screen.getByRole('button',{name:'작게 보기'}));expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
 expect(screen.getByRole('textbox',{name:'답변'})).toHaveValue('expanded draft');expect(screen.getByRole('button',{name:'크게 보기'})).toHaveFocus();
});
it('provides escape dismissal and keeps disabled decision actions disabled in the enlarged view',()=>{
 const action=vi.fn();render(<QuestionPanel title="권한 요청" actions={<button disabled onClick={action}>승인</button>}><p>긴 권한 설명</p></QuestionPanel>);
 fireEvent.click(screen.getByRole('button',{name:'크게 보기'}));expect(screen.getByRole('button',{name:'승인'})).toBeDisabled();
 fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(action).not.toHaveBeenCalled();
});
