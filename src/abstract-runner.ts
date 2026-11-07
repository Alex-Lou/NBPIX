/**
 * Le cycle de vie du calcul : un worker par travail, terminé dès qu'il a rendu ou qu'on l'annule.
 *
 * Un worker par travail plutôt qu'un worker gardé en vie : le démarrage coûte quelques
 * millisecondes contre des secondes de calcul, et c'est ce qui garantit qu'une annulation arrête
 * vraiment le processeur au lieu de laisser tourner un résultat dont plus personne ne veut. Rien
 * ne survit à un `cancel`, donc rien ne fuit et aucun résultat périmé ne peut revenir.
 */

import type { Answer, Job } from './abstract.worker.ts';
import type { Bitmap } from './pixels.ts';

export interface Runner {
  /** Lance un calcul, en annulant celui qui courait. */
  readonly start: (job: Job) => void;
  /** Arrête ce qui court, s'il y a lieu. */
  readonly cancel: () => void;
  readonly busy: () => boolean;
}

export interface Watcher {
  readonly done: (cell: Bitmap, colors: number, passes: number) => void;
  readonly failed: (why: string) => void;
}

export function runnerOn(watcher: Watcher): Runner {
  let worker: Worker | undefined;

  function stop(): void {
    worker?.terminate();
    worker = undefined;
  }

  return {
    busy: () => worker !== undefined,
    cancel: stop,
    start: (job) => {
      stop();
      const fresh = new Worker(new URL('./abstract.worker.ts', import.meta.url), {
        type: 'module',
      });
      worker = fresh;
      fresh.addEventListener('message', (event: MessageEvent) => {
        // Un message d'un worker déjà remplacé ne concerne plus personne.
        if (worker !== fresh) return;
        stop();
        const answer = event.data as Answer;
        if (!answer.ok) {
          watcher.failed(answer.why);
          return;
        }
        watcher.done(
          { width: answer.width, height: answer.height, data: answer.data },
          answer.colors,
          answer.passes,
        );
      });
      fresh.addEventListener('error', (event: ErrorEvent) => {
        if (worker !== fresh) return;
        stop();
        watcher.failed(event.message || 'le worker a échoué');
      });
      fresh.postMessage(job);
    },
  };
}
