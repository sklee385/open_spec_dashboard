import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LegacyService } from '../legacy/legacy.service';
import { directories, markdownFiles } from '../legacy/parser';
import { textFile, within } from '../files';
import { documentVersion, extractReviewItems, ReviewItem } from './review-items';

@Injectable()
export class ReviewService {
  constructor(@Inject(LegacyService) private readonly legacy: LegacyService) {}
  change(id: string) {
    const [sourceId, name] = this.legacy.splitId(id), source = this.legacy.source(sourceId);
    let root = within(source.path, `changes/${name}`);
    if (!existsSync(root)) {
      const archive = directories(join(source.path, 'changes/archive')).find(x => x === name || x.endsWith(`-${name}`));
      if (!archive) throw new NotFoundException('변경이 없습니다');
      root = within(source.path, `changes/archive/${archive}`);
    }
    if (!statSync(root).isDirectory()) throw new NotFoundException('변경이 없습니다');
    return this.read(root);
  }
  async read(root: string) {
    const items: ReviewItem[] = [], documentVersions: Record<string, string> = {};
    const errors: { path: string; code: string; message: string }[] = [];
    const failure = (path: string, error: any) => {
      if (error?.getStatus?.() === 400) throw error;
      errors.push({ path, code: error?.code || 'READ_FAILED', message: '문서를 읽지 못했습니다' });
    };
    let specs: string[] = [];
    try { specs = markdownFiles(within(root, 'specs')).map(path => `specs/${path}`); }
    catch (error) { failure('specs/', error); }
    for (const path of ['proposal.md', 'design.md', 'tasks.md', ...specs]) {
      try {
        const content = textFile(within(root, path));
        if (content === null) { failure(path, { code: 'ENOENT' }); continue; }
        documentVersions[path] = documentVersion(content);
        items.push(...await extractReviewItems(path, content));
      } catch (error) { failure(path, error); }
    }
    return { items, documentVersions, errors };
  }
}
