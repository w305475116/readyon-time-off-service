import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('audit_events')
export class AuditEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text', nullable: true })
  requestId!: string | null;

  @Column({ type: 'text', nullable: true })
  employeeId!: string | null;

  @Column({ type: 'text', nullable: true })
  locationId!: string | null;

  @Column()
  eventType!: string;

  @Column({ type: 'simple-json', nullable: true })
  payload!: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt!: Date;
}
