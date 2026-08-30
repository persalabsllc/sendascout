import Link from "next/link";
import {
  IconArrowLeft,
  IconBriefcase,
  IconBuildingStore,
  IconCalendarRepeat,
  IconCash,
  IconChartBar,
  IconClock,
  IconCoin,
  IconFileDescription,
  IconHeartHandshake,
  IconPhotoCheck,
  IconReceipt,
  IconRoute,
  IconShieldLock,
  IconTemplate,
  IconUsersGroup,
  type Icon,
} from "@tabler/icons-react";
import type { AnalyticsSnapshot } from "@/app/control-room/analytics/metrics";
import { Brand } from "./brand";
import styles from "./control-room-analytics.module.css";

export function ControlRoomAnalytics({ snapshot }: { snapshot: AnalyticsSnapshot }) {
  const { financial, operations, features } = snapshot;
  const preferredRate = ratio(features.preferredConversions, features.preferredOffers);
  const extensionRate = ratio(features.acceptedExtensions, features.extensionRequests);

  return <main className="control-page">
    <header className="control-header"><Brand href="/control-room" /><div><span>Private operations</span><Link href="/control-room">Control Room</Link><Link href="/control-room/customers">Customers</Link><Link href="/control-room/scouts">Scouts</Link><Link href="/">Public site</Link></div></header>
    <div className="control-shell">
      <Link className="control-back" href="/control-room"><IconArrowLeft size={16} /> Marketplace operations</Link>
      <div className="control-title"><div><span className="kicker">Marketplace intelligence</span><h1>Performance and revenue</h1><p>All-time operating metrics through {new Date(snapshot.generatedAt).toLocaleString()}.</p></div></div>

      <section className={styles.notice} aria-label="Revenue reporting note">
        <IconReceipt size={22} />
        <div><strong>Booked value is not collected revenue.</strong><p>Booked and projected figures include unpaid marketplace activity. Collected revenue only includes payment-ledger rows marked paid, so it remains $0 until live Stripe capture succeeds.</p></div>
      </section>

      <section aria-labelledby="revenue-heading">
        <div className={styles.sectionHeading}><div><span>Revenue</span><h2 id="revenue-heading">Marketplace economics</h2></div><small>Excludes cancelled orders</small></div>
        <div className={styles.metricGrid}>
          <MetricCard icon={IconReceipt} label="Booked value" value={money(financial.bookedValueCents)} detail={`${operations.totalOrders - operations.cancelledOrders} non-cancelled orders`} />
          <MetricCard icon={IconCash} label="Collected revenue" value={money(financial.collectedRevenueCents)} detail="Paid ledger entries only" emphasis="verified" />
          <MetricCard icon={IconCoin} label="Projected Scout pay" value={money(financial.projectedScoutPayoutCents)} detail="Not yet disbursed" />
          <MetricCard icon={IconChartBar} label="Projected platform fee" value={money(financial.projectedPlatformFeeCents)} detail={`${money(financial.bundleDiscountCents)} bundle savings funded`} />
        </div>
      </section>

      <div className={styles.twoColumn}>
        <section className="control-section" aria-labelledby="operations-heading">
          <div className="control-section-title"><div><h2 id="operations-heading">Order health</h2><p>Bundles count once; legacy missions remain one order each.</p></div></div>
          <div className={styles.statList}>
            <StatRow label="All orders" value={integer(operations.totalOrders)} />
            <StatRow label="Active" value={integer(operations.activeOrders)} />
            <StatRow label="Completed" value={integer(operations.completedOrders)} />
            <StatRow label="Cancelled" value={integer(operations.cancelledOrders)} />
            <StatRow label="Average booked order" value={money(operations.averageOrderCents)} />
          </div>
        </section>

        <section className="control-section" aria-labelledby="customer-heading">
          <div className="control-section-title"><div><h2 id="customer-heading">Customer retention</h2><p>Based on customers with at least one non-cancelled order.</p></div></div>
          <div className={styles.statList}>
            <StatRow label="Ordering customers" value={integer(operations.orderingCustomers)} />
            <StatRow label="Repeat customers" value={integer(operations.repeatCustomers)} />
            <StatRow label="Repeat customer rate" value={percent(operations.repeatCustomerRate)} />
            <StatRow label="Business accounts" value={integer(features.businessAccounts)} detail="Foundation only · billing not active" />
          </div>
        </section>
      </div>

      <div className={styles.twoColumn}>
        <section className="control-section" aria-labelledby="speed-heading">
          <div className="control-section-title"><div><h2 id="speed-heading">Marketplace speed</h2><p>Elapsed time from mission creation, not scheduled appointment time.</p></div></div>
          <div className={styles.speedCards}>
            <article><IconClock size={22} /><div><span>Average time to claim</span><strong>{durationMinutes(operations.averageMinutesToClaim)}</strong><small>{operations.claimSampleSize} claimed order{operations.claimSampleSize === 1 ? "" : "s"}</small></div></article>
            <article><IconRoute size={22} /><div><span>Average time to completion</span><strong>{durationHours(operations.averageHoursToComplete)}</strong><small>{operations.completionSampleSize} completed order{operations.completionSampleSize === 1 ? "" : "s"}</small></div></article>
          </div>
        </section>

        <section className="control-section" aria-labelledby="mix-heading">
          <div className="control-section-title"><div><h2 id="mix-heading">Mission mix</h2><p>Service legs booked; each leg in a multi-part order is represented.</p></div></div>
          <div className={styles.mixList}>{snapshot.missionMix.map((item) => <article key={item.type}>
            <div><strong>{titleCase(item.type)} It</strong><span>{item.count} service leg{item.count === 1 ? "" : "s"}</span></div>
            <div className={styles.track} aria-hidden="true"><span style={{ width: `${item.percent}%` }} /></div>
            <b>{item.percent}%</b>
          </article>)}</div>
        </section>
      </div>

      <section className="control-section" aria-labelledby="features-heading">
        <div className="control-section-title"><div><h2 id="features-heading">Feature adoption</h2><p>Early indicators for the new revenue and trust features.</p></div></div>
        <div className={styles.featureGrid}>
          <FeatureCard icon={IconTemplate} label="Saved templates" value={integer(features.activeTemplates)} detail="Active customer templates" />
          <FeatureCard icon={IconCalendarRepeat} label="Recurring schedules" value={`${features.activeRecurrences} active`} detail={`${features.totalRecurrences} total schedules`} />
          <FeatureCard icon={IconBriefcase} label="Multi-part orders" value={integer(features.multipartBundles)} detail={`${money(financial.bundleDiscountCents)} customer savings`} />
          <FeatureCard icon={IconFileDescription} label="Extensions" value={`${features.acceptedExtensions}/${features.extensionRequests}`} detail={`${percent(extensionRate)} accepted · ${money(features.extensionValueCents)} approved`} />
          <FeatureCard icon={IconHeartHandshake} label="Preferred Scout reuse" value={`${features.preferredConversions}/${features.preferredOffers}`} detail={`${percent(preferredRate)} accepted by preferred Scout`} />
          <FeatureCard icon={IconUsersGroup} label="Enhanced reports" value={integer(features.enhancedReports)} detail="Service legs with structured reporting" />
          <FeatureCard icon={IconPhotoCheck} label="Delivery proof" value={integer(features.proofOfDeliveryMissions)} detail="Move It legs requiring a photo" />
          <FeatureCard icon={IconShieldLock} label="PIN-protected delivery" value={integer(features.pinProtectedMissions)} detail="Move It legs requiring recipient confirmation" />
          <FeatureCard icon={IconBuildingStore} label="Business accounts" value={integer(features.businessAccounts)} detail="Free foundation · no subscription billing" />
        </div>
      </section>
    </div>
  </main>;
}

function MetricCard({ icon: IconComponent, label, value, detail, emphasis }: { icon: Icon; label: string; value: string; detail: string; emphasis?: "verified" }) {
  return <article className={emphasis ? styles.verifiedMetric : undefined}><IconComponent size={24} /><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></article>;
}

function FeatureCard({ icon: IconComponent, label, value, detail }: { icon: Icon; label: string; value: string; detail: string }) {
  return <article><IconComponent size={21} /><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></article>;
}

function StatRow({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <div><span>{label}{detail && <small>{detail}</small>}</span><strong>{value}</strong></div>;
}

function ratio(numerator: number, denominator: number) { return denominator ? numerator / denominator : 0; }
function integer(value: number) { return new Intl.NumberFormat("en-US").format(value); }
function money(cents: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100); }
function percent(value: number) { return new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 }).format(value); }
function titleCase(value: string) { return value.replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function durationMinutes(value: number | null) {
  if (value === null) return "No data";
  if (value < 60) return `${Math.round(value)} min`;
  return `${(value / 60).toFixed(1)} hr`;
}
function durationHours(value: number | null) {
  if (value === null) return "No data";
  if (value < 1) return `${Math.round(value * 60)} min`;
  return `${value.toFixed(1)} hr`;
}
