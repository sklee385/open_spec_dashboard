import { screen } from '@testing-library/react';
import { render } from '../test/render';
import { expect, it, vi } from 'vitest';
import { MermaidBlock } from './MermaidBlock';

vi.mock('mermaid', () => { throw new Error('청크 다운로드 실패'); });

it('지연 로드 실패 시 다른 문서와 원문을 유지한다', async () => {
  render(<><h1>문서 유지</h1><MermaidBlock source={'flowchart LR\nA-->B'} /></>);
  expect(await screen.findByRole('alert')).toHaveTextContent('렌더러 로딩');
  expect(screen.getByText('flowchart LR A-->B')).toBeVisible();
  expect(screen.getByRole('heading', { name: '문서 유지' })).toBeVisible();
});
