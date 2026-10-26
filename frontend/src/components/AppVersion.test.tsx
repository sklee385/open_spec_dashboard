import { cleanup, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { render } from '../test/render';
import { AppVersion } from './AppVersion';
import product from '../../../package.json';

afterEach(cleanup);

it('빌드에 주입된 루트 제품 버전을 표시한다', () => {
  render(<AppVersion />);
  expect(screen.getByLabelText('앱 버전')).toHaveTextContent(`v${product.version}`);
});

it('제품 버전과 사전 배포 식별자를 유지하고 공백만 정리한다', () => {
  render(<AppVersion version=" 1.2.3-beta.1+build.4 " />);
  expect(screen.getByLabelText('앱 버전')).toHaveTextContent('v1.2.3-beta.1+build.4');
});

it.each([null, '', '   '])('정보가 없으면 한국어 대체 문구를 표시한다: %s', version => {
  render(<AppVersion version={version} />);
  expect(screen.getByLabelText('앱 버전')).toHaveTextContent('버전 확인 불가');
});

it('영어 화면에서는 영어 대체 문구를 표시한다', () => {
  render(<AppVersion version={null} />, { locale: 'en' });
  expect(screen.getByLabelText('App version')).toHaveTextContent('Version unavailable');
});
