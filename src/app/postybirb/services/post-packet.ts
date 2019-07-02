import { Submission } from 'src/app/database/models/submission.model';
import { WebsiteRegistry } from 'src/app/websites/registries/website.registry';
import { BehaviorSubject, Observable } from 'rxjs';

export enum PacketStatus {
  CANCELLED = 'CANCELLED',
  COMPLETE = 'COMPLETE',
  FAILED = 'FAILED',
  POSTING = 'POSTING',
  WAITING = 'WAITING',
}

export class SubmissionPacket {
  get id(): number { return this.submission.id }

  private packets: PostPacket[] = [];
  public cancelled: boolean = false;
  public isAsync: boolean = true;

  constructor(private submission: Submission) {
    this._generatePackets();
  }

  private _generatePackets(): void {
    const websites = this.submission.formData.websites;
    this.packets = websites
      .sort((a, b) => {
        const aUsesSrc = WebsiteRegistry.getConfigForRegistry(a).websiteConfig.acceptsSrcURL ? true : false;
        const bUsesSrc = WebsiteRegistry.getConfigForRegistry(b).websiteConfig.acceptsSrcURL ? true : false;

        if (!aUsesSrc && !bUsesSrc) {
          // Name based sort
          if (a < b) return -1;
          if (a > b) return 1;
          return 0;
        } else if (bUsesSrc && aUsesSrc) {
          // Name based sort
          if (a < b) return -1;
          if (a > b) return 1;
          return 0;
        } else {
          if (aUsesSrc && !bUsesSrc) return 1;
          else return -1;
        }
      })
      .map(website => new PostPacket(this, this.submission, website));

    // Make non-async when there is a website that takes src url
    for (let i = 0; i < this.packets.length; i++) {
      if (!this.packets[i].isAsync) {
        this.isAsync = false;
        break;
      }
    }
  }

  public cancel(): void {
    this.cancelled = true;
    this.packets
      .filter(p => p.status !== PacketStatus.COMPLETE)
      .filter(p => p.status !== PacketStatus.FAILED)
      .forEach(p => p.cancel());
  }

  public cleanUp(): void {
    this.packets
      .filter(p => p.status !== PacketStatus.COMPLETE)
      .filter(p => p.status !== PacketStatus.FAILED)
      .forEach(p => p.cancel());
  }

  public getNextPacket(): PostPacket | null {
    return this.packets.find(packet => packet.status === PacketStatus.WAITING);
  }

  public getPackets(): PostPacket[] {
    return this.packets.filter(p => p.status === PacketStatus.WAITING);
  }

  public getUnfilteredPackets(): PostPacket[] { return this.packets }

  public getSubmission(): Submission { return this.submission }

  public getUnpostedWebsites(): string[] {
    return [...this.submission.formData.websites, ...this.submission.postStats.fail];
  }

  public isCompletable(): boolean {
    return this.packets
      .filter(p => p.status === PacketStatus.WAITING || p.status === PacketStatus.POSTING)
      .length === 0
  }

  public onlyHasSyncPackets(): boolean {
    return this.packets
      .filter(p => p.status === PacketStatus.WAITING || p.status === PacketStatus.POSTING)
      .filter(p => p.isAsync)
      .length === 0;
  }

}

export class PostPacket {
  get id(): number { return this.submission.id }
  get isCancelled(): boolean { return this.status === PacketStatus.CANCELLED }

  get canPost(): boolean {
    if (this.parent.isAsync) return true;
    else if (this.isAsync) return true;
    else return this.parent.onlyHasSyncPackets();
  }

  public status: PacketStatus = PacketStatus.WAITING;
  public isAsync: boolean;
  public postingTime: Date;

  private update: BehaviorSubject<PacketStatus> = new BehaviorSubject(PacketStatus.WAITING);
  public statusUpdate: Observable<PacketStatus> = this.update.asObservable();

  constructor(private parent: SubmissionPacket, private submission: Submission, public website: string) {
    this.isAsync = !WebsiteRegistry.getConfigForRegistry(website).websiteConfig.acceptsSrcURL;
  }

  public aboutToPost(): void {
    const index: number = this.submission.formData.websites.indexOf(this.website);
    this.submission.formData.websites.splice(index, 1); // remove the website from the list
    this.submission.formData = Object.assign({}, this.submission.formData); // trigger DB update
    this.status = PacketStatus.POSTING;
    this.update.next(PacketStatus.POSTING);
  }

  public cancel(): void {
    if (this.status !== PacketStatus.POSTING) {
      this.status = PacketStatus.CANCELLED;
      this.update.next(this.status);
    }
  }

  public getSubmission(): Submission { return this.submission }

  public postFailed(): void {
    this.submission.postStats.fail.push(this.website);
    this.status = PacketStatus.FAILED;
    this.update.next(this.status);
  }

  public postCompleted(): void {
    this.submission.postStats.success.push(this.website);
    this.status = PacketStatus.COMPLETE;
    this.update.next(this.status);
  }

  public setPostingTime(time: Date): void {
    this.postingTime = time;
    this.status = PacketStatus.WAITING;
    this.update.next(this.status);
  }
}
