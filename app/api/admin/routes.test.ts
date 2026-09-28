/// <reference types="vite/client" />
import { describe, it, expect, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { resetEnvCache } from '@/lib/env';

const routeModules = import.meta.glob('./**/route.ts') as Record<
  string,
  () => Promise<Record<string, unknown>>
>;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type Handler = (
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

beforeAll(() => {
  process.env.MONGODB_URI = 'mongodb://127.0.0.1:1'; // never reached: withAdmin rejects first
  process.env.CMS_JWT_SECRET = 'test-secret-test-secret-test-secret-1234';
  resetEnvCache();
});

describe('every /api/admin route rejects anonymous requests', () => {
  const entries = Object.entries(routeModules);

  it('finds the complete current admin route inventory', () => {
    expect(entries.map(([p]) => p).sort()).toEqual([
      './api-keys/[id]/rotate/route.ts',
      './api-keys/[id]/route.ts',
      './authors/[slug]/route.ts',
      './authors/route.ts',
      './blogs/[slug]/revisions/[revisionId]/restore/route.ts',
      './blogs/[slug]/revisions/[revisionId]/route.ts',
      './blogs/[slug]/revisions/route.ts',
      './blogs/[slug]/route.ts',
      './blogs/route.ts',
      './faq-submissions/[id]/route.ts',
      './faq-submissions/route.ts',
      './faqs/[id]/route.ts',
      './faqs/route.ts',
      './newsletter-subscribers/route.ts',
      './release-notes/[slug]/route.ts',
      './release-notes/route.ts',
      './session/route.ts',
      './sites/[siteId]/api-keys/route.ts',
      './sites/[siteId]/route.ts',
      './sites/[siteId]/webhook-secret/route.ts',
      './sites/route.ts',
      './upload/complete/route.ts',
      './upload/route.ts',
      './users/[userId]/route.ts',
      './users/route.ts',
      './whitepapers/[slug]/route.ts',
      './whitepapers/route.ts',
    ]);
  });

  for (const [path, load] of entries) {
    it(`${path} → 401 UNAUTHORIZED on every exported method`, async () => {
      const mod = await load();
      expect(mod.dynamic, `${path} must export dynamic = 'force-dynamic'`).toBe('force-dynamic');
      const exported = METHODS.filter((m) => typeof mod[m] === 'function');
      expect(exported.length, `${path} exports no handlers`).toBeGreaterThan(0);
      for (const method of exported) {
        const url = `http://localhost:3003${path.replace('./', '/api/admin/').replace('/route.ts', '')}`;
        const headers = new Headers({
          origin: 'http://localhost:3003',
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
        });
        const res = await (mod[method] as Handler)(new NextRequest(url, { method, headers }), {
          params: Promise.resolve({ slug: 'x', id: 'x', siteId: 'x', userId: 'x' }),
        });
        expect(res.status, `${path} ${method}`).toBe(401);
        expect((await res.json()).code).toBe('UNAUTHORIZED');
      }
    }, 15_000);
  }
});
