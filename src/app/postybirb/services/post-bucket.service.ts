import { Injectable, isDevMode } from '@angular/core';
import { WebsiteRegistry, WebsiteRegistryConfig } from 'src/app/websites/registries/website.registry';
import { PostPacket, SubmissionPacket, PacketStatus } from './post-packet';
import { Submission } from 'src/app/database/models/submission.model';
import { Subscription, Subject, Observable } from 'rxjs';
import { filter } from 'rxjs/operators';
import { TabManager } from './tab-manager.service';
import { PostManagerService } from './post-manager.service';
import { SubmissionDBService } from 'src/app/database/model-services/submission.service';
import { GeneratedThumbnailDBService } from 'src/app/database/model-services/generated-thumbnail.service';
import { TranslateService } from '@ngx-translate/core';
import { SnotifyService } from 'ng-snotify';
import { PostLoggerService } from './post-logger.service';
import { blobToUint8Array } from 'src/app/utils/helpers/file.helper';
import { SubmissionFileType } from 'src/app/database/tables/submission-file.table';
import { PostResult } from 'src/app/websites/interfaces/website-service.interface';

@Injectable({
  providedIn: 'root'
})
export class PostBucket {
  private buckets: any = {};
  private packetQueue: SubmissionPacket[] = [];

  private queueStatus: Subject<SubmissionPacket[]> = new Subject();
  public readonly queueUpdates: Observable<SubmissionPacket[]> = this.queueStatus.asObservable();

  constructor(
    private _tabManager: TabManager,
    private _submissionDB: SubmissionDBService,
    private _generatedThumbnailDB: GeneratedThumbnailDBService,
    private _postLogger: PostLoggerService,
    private _translate: TranslateService,
    public _postManager: PostManagerService,
    public snotify: SnotifyService
  ) {
    // Initialize buckets
    WebsiteRegistry.getRegisteredAsArray().forEach(config => {
      this.buckets[config.name] = new Bucket(this, config, this._packetSegmentCompleted.bind(this));
    });
  }

  public enqueue(submission: Submission): void {
    if (!this._find(submission.id)) {
      this._tabManager.removeTab(submission.id);

      // Filter out any duplicates that may have gotten in through a bug
      const websitesToPost = [];
      submission.formData.websites.forEach(website => {
        if (!websitesToPost.includes(website)) websitesToPost.push(website);
        else if (isDevMode()) console.warn(`Duplicate website found [${submission.id}]: ${website}`);
      });

      submission.formData.websites = websitesToPost;
      submission.postStats.originalCount = submission.formData.websites.length;
      submission.postStats.fail = [];
      submission.postStats.success = [];

      this.packetQueue.push(new SubmissionPacket(submission));
      submission.queued = true;

      this._attemptToFillBucket();
      this._notify();
    }
  }

  public dequeue(submission: Submission, submissionCancelled: boolean = false): void {
    const index: number = this._findIndex(submission.id);
    if (index !== -1) {
      submission.queued = false;
      // Regenerate websites
      const sP: SubmissionPacket = this.packetQueue[index];
      submission.formData.websites = sP.getUnpostedWebsites().sort();
      submission.formData = Object.assign({}, submission.formData);
      if (submissionCancelled) sP.cancel();
      else sP.cleanUp();
      this.packetQueue.splice(index, 1);
    }

    this._notify();
  }

  private _findIndex(id: number): number {
    return this.packetQueue.findIndex(p => p.id === id);
  }

  private _find(id: number): SubmissionPacket | null {
    return this.packetQueue.find(p => p.id === id);
  }

  private _attemptToFillBucket(): void {
    const schedule: { [key: string]: PostPacket } = {};
    this.packetQueue.forEach(sP => {
      sP.getPackets().forEach(packet => {
        if (!schedule[packet.website]) {
          schedule[packet.website] = packet;
        }
      });
    });

    Object.values(schedule)
      .filter(packet => packet.canPost) // async blocker
      .forEach(packet => this.buckets[packet.website].enter(packet));
  }

  private _packetSegmentCompleted(packet: PostPacket): void {
    const parentPacket: SubmissionPacket = this._find(packet.id);
    if (parentPacket) {
      const nextPacket = parentPacket.getNextPacket();
      if (!nextPacket && parentPacket.isCompletable()) {
        const submission: Submission = parentPacket.getSubmission();
        this.dequeue(submission);
        this._postLogger.addLog(submission);
        this._outputNotification(submission, parentPacket.cancelled)
          .finally(() => {
            if (submission.formData.websites.length || submission.postStats.fail.length) {
              // Enter Condition: When posting completed, but it has failures or other websites
              if (!this.packetQueue.length && closeAfterPost() /* global var*/) {
                setTimeout(() => {
                  if (closeAfterPost()) {
                    window.close();
                  }
                }, 15000); // allow enough time for db to be updated and any writers hopefully
              }
            } else {
              // Enter Condition: When posting completes, and no issues are found
              submission.cleanUp();
              this._tabManager.removeTab(submission.id);
              this._submissionDB.delete([submission.id])
                .finally(() => {
                  if (!this.packetQueue.length && closeAfterPost() /* global var*/) {
                    setTimeout(() => {
                      if (closeAfterPost()) {
                        window.close();
                      }
                    }, 15000); // allow enough time for db to be updated and any writers hopefully
                  }
                });
            }
          });
      }
    }

    this._attemptToFillBucket();
  }

  private async _outputNotification(submission: Submission, wasCancelled: boolean = false): Promise<void> {
    const failed = submission.postStats.fail.length > 0;

    try {
      const thumbnail = await this._generatedThumbnailDB.getThumbnail(submission.id, SubmissionFileType.PRIMARY_FILE);
      let icon = null;
      if (thumbnail && thumbnail.length) {
        icon = 'data:image/jpeg;base64,' + Buffer.from(await blobToUint8Array(thumbnail[0].buffer)).toString('base64');
      }

      if (wasCancelled) {
        new Notification(this._translate.instant('Cancelled'), {
          body: submission.title || submission.fileInfo.name,
          icon
        });
      } else {
        new Notification(this._translate.instant(failed ? 'Failed' : 'Success'), {
          body: submission.title || submission.fileInfo.name,
          icon
        });
      }

      if (failed) {
        this.snotify.error(`${submission.title} (${submission.postStats.fail.join(', ')})`, { timeout: 15000, showProgressBar: true });
      } else if (wasCancelled) {
        this.snotify.warning(this._translate.instant('Cancelled') + '-' + submission.title || submission.fileInfo.name, { timeout: 3000, showProgressBar: true });
      } else {
        this.snotify.success(submission.title || submission.fileInfo.name, { timeout: 3000, showProgressBar: true });
      }
    } catch (e) { /* ignore */ }

    return;
  }

  public getSubmissionPacketForId(id: number): SubmissionPacket { return this._find(id) }

  public _notify(): void { this.queueStatus.next(this.packetQueue) }

  public packetFailed(id: number): void {
    if (settingsDB.get('clearQueueOnFailure').value()) {
      const index: number = this._findIndex(id);
      const cancelPosts: SubmissionPacket[] = this.packetQueue.slice(index + 1, this.packetQueue.length) || [];
      cancelPosts.forEach(sP => {
        sP.cancel();
        this.dequeue(sP.getSubmission());
        this._outputNotification(sP.getSubmission(), true);
      });
    }
  }
}

class Bucket {
  private timeToWait: number = 0;
  private website: string;

  private waitTimer: any;
  private useWaitIntervalIfSet: boolean = false;
  private currentPacket: PostPacket;
  private statusSubscription: Subscription = Subscription.EMPTY;

  constructor(private parent: PostBucket, private config: WebsiteRegistryConfig, private callback: any) {
    this.timeToWait = config.websiteConfig.postWaitInterval || 0;
    this.website = config.name;
  }

  public enter(packet: PostPacket): void {
    if (!this.currentPacket && !packet.isCancelled) {
      this.currentPacket = packet;
      this.statusSubscription = packet.statusUpdate
        .pipe(filter(status => status === PacketStatus.CANCELLED))
        .subscribe(cancelStatus => {
          /*
          * If the post has not actually started
          * 1) Clean up timer
          * 2) Unsubcribe and callback
          * If it has started, it generally isn't safe to try and kill it.
           */
          if (cancelStatus === PacketStatus.CANCELLED && this.waitTimer) {
            clearTimeout(this.waitTimer);
            this.waitTimer = null;
            this.statusSubscription.unsubscribe();
            this.currentPacket = null;
            this.callback(packet);
          }
        });

      const waitTime = this._getWaitTime();
      this.currentPacket.setPostingTime(new Date(Date.now() + waitTime));
      this.waitTimer = setTimeout(this.post.bind(this), waitTime);
    } else if (packet.isCancelled) {
      this.callback(packet);
    }
  }

  // Posting Logic
  private post(): void {
    this.waitTimer = null;
    const packet = this.currentPacket;
    if (packet.isCancelled) {
      this.currentPacket = null;
      this.statusSubscription.unsubscribe();
      this.callback(packet);
      return;
    }

    packet.aboutToPost();
    this._archivePostTime();
    const submission: Submission = this.currentPacket.getSubmission();
    this.parent._postManager.post(this.website, submission)
      .then((data: PostResult) => {
        if (data) {
          if (data.srcURL) {
            submission.postStats.sourceURLs.push(data.srcURL);
          }
        }
        packet.postCompleted();
      })
      .catch((err: PostResult) => {
        packet.postFailed();

        // TODO move some of this into packet code?
        let error = err instanceof Error ? err : err.error;
        if (error instanceof Error) {
          error = `${error.toString()}\n${error.stack}`;
        }
        submission.postStats.errors.push(error);

        // Check to see if it was interrupted while posting
        if (packet.isCancelled) {
          submission.formData.websites = [...submission.formData.websites, this.website].sort();
          submission.formData = Object.assign({}, submission.formData);
        }

        if (err.msg) {
          this.parent.snotify.error(`${this.website} - ${err.msg}`, `${submission.title || 'Untitled'}`, {
            timeout: 10000
          });
        }
      })
      .finally(() => {
        submission.postStats = Object.assign({}, submission.postStats); // force update db model
        this.useWaitIntervalIfSet = true;
        this.statusSubscription.unsubscribe();
        this.currentPacket = null;

        if (packet.status === PacketStatus.FAILED) {
          this.parent.packetFailed(packet.id);
        }

        this.callback(packet);
      });
  }

  private _archivePostTime(): void {
    store.set(`${this.website}-last-post-time`, Date.now());
  }

  private _getLastPostTime(): number {
    return store.get(`${this.website}-last-post-time`) || 0;
  }

  private _getWaitTime(): number {
    const timeDifference: number = Date.now() - this._getLastPostTime(); // the time between the last post time and now
    const userSetWaitInterval: number = settingsDB.get('postInterval').value() || 0;

    let waitTime: number = this.timeToWait;
    if (timeDifference >= waitTime) { // when the time since the last post is already greater than the specified wait time
      waitTime = this.useWaitIntervalIfSet && userSetWaitInterval > 0 ? userSetWaitInterval * 60000 /* assumed to be in minutes */ : 5000;
    } else {
      const calculatedWaitTime = Math.max(Math.abs(timeDifference - waitTime), 5000);
      waitTime = this.useWaitIntervalIfSet && userSetWaitInterval > 0 ? userSetWaitInterval * 60000 /* assumed to be in minutes */ : calculatedWaitTime;
    }

    this.useWaitIntervalIfSet = false;

    return waitTime;
  }
}
