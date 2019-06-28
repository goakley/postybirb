import { Component, OnInit, OnDestroy, Input, ChangeDetectorRef, ChangeDetectionStrategy } from '@angular/core';
import { Subscription } from 'rxjs';
import { QueueInserterService } from '../../services/queue-inserter.service';
import { SubmissionPacket } from '../../services/post-packet';
import { Submission } from 'src/app/database/models/submission.model';
import { PostBucket } from '../../services/post-bucket.service';

@Component({
  selector: 'submission-posting-view',
  templateUrl: './submission-posting-view.component.html',
  styleUrls: ['./submission-posting-view.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SubmissionPostingViewComponent implements OnInit, OnDestroy {
  @Input() submission: Submission;
  public submissionPacket: SubmissionPacket;

  private packetListeners: Subscription[] = [];

  constructor(private _bucketQueue: PostBucket, private _queueInserter: QueueInserterService, private _changeDetector: ChangeDetectorRef) { }

  ngOnInit() {
    this.submissionPacket = this._bucketQueue.getSubmissionPacketForId(this.submission.id);
    this.packetListeners = this.submissionPacket.getPackets()
      .map(packet => packet.statusUpdate.subscribe(() => this._changeDetector.markForCheck()));
  }

  ngOnDestroy() {
      this.packetListeners.forEach(listener => listener.unsubscribe());
      this.packetListeners = [];
  }

  public cancel(): void {
    this._queueInserter.dequeue(this.submission);
  }

  public getProgress(): number {
    return Math.floor(((this.submission.postStats.success.length + this.submission.postStats.fail.length) / this.submission.postStats.originalCount) * 100);
  }

}
