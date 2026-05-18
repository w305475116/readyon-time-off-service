import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export enum BalanceProjectionSource {
  RealtimeHcm = 'REALTIME_HCM',
  BatchHcm = 'BATCH_HCM'
}

@Entity('balance_projections')
export class BalanceProjectionEntity {
  @PrimaryColumn()
  employeeId!: string;

  @PrimaryColumn()
  locationId!: string;

  @Column('real')
  availableDays!: number;

  @Column({
    type: 'text',
    enum: BalanceProjectionSource
  })
  source!: BalanceProjectionSource;

  @Column({ type: 'datetime' })
  lastSyncedAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

