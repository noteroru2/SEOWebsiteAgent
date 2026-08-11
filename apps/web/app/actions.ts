'use server';
import { enqueueJob } from '@seo-agent/database';
import { revalidatePath } from 'next/cache';

export async function enqueueSystemTest() {
  await enqueueJob({ type: 'SYSTEM_TEST' });
  revalidatePath('/');
  revalidatePath('/jobs');
}
