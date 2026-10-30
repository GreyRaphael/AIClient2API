/** 仪表盘联系方式与赞助商（Phase 3 迁移，图片随语言切换）。 */
import { html } from '../../html.js';
import { t, lang } from '../../lib/i18n.js';

const QrPlaceholder = () => html`
    <svg class="qr-placeholder" viewBox="0 0 100 100" role="img" aria-label=${t('dashboard.contact.placeholder')}>
        <rect x="0" y="0" width="100" height="100" rx="6" fill="none" stroke="currentColor" stroke-width="2"
            stroke-dasharray="6 5" opacity="0.35" />
        <g fill="none" stroke="currentColor" stroke-width="3" opacity="0.5">
            <rect x="18" y="18" width="20" height="20" rx="3" />
            <rect x="62" y="18" width="20" height="20" rx="3" />
            <rect x="18" y="62" width="20" height="20" rx="3" />
        </g>
        <g fill="currentColor" opacity="0.35">
            <rect x="23" y="23" width="10" height="10" rx="1.5" />
            <rect x="67" y="23" width="10" height="10" rx="1.5" />
            <rect x="23" y="67" width="10" height="10" rx="1.5" />
        </g>
        <g fill="currentColor" opacity="0.28">
            <rect x="46" y="46" width="6" height="6" /><rect x="56" y="46" width="6" height="6" />
            <rect x="46" y="56" width="6" height="6" /><rect x="66" y="56" width="6" height="6" />
            <rect x="76" y="66" width="6" height="6" /><rect x="56" y="76" width="6" height="6" />
            <rect x="46" y="76" width="6" height="6" /><rect x="76" y="46" width="6" height="6" />
        </g>
    </svg>`;

export function DashboardContact() {
    const isEnglish = lang.value === 'en-US';

    const contact = isEnglish
        ? {
            icon: 'fab fa-x-twitter',
            title: t('dashboard.contact.x')
        }
        : {
            icon: 'fab fa-weixin',
            title: t('dashboard.contact.wechat')
        };

    const support = isEnglish
        ? {
            title: t('dashboard.contact.coffee')
        }
        : {
            title: t('dashboard.contact.sponsor')
        };

    return html`
        <div class="contact-section dashboard-contact">
            <div class="contact-grid">
                <div class="contact-card">
                    <h3><i class=${contact.icon}></i> <span>${contact.title}</span></h3>
                    <div class="qr-container">
                        <${QrPlaceholder} />
                    </div>
                </div>
                <div class="contact-card" id="sponsor-card">
                    <h3><i class="fas fa-heart"></i> <span>${support.title}</span></h3>
                    <div class="qr-container">
                        <${QrPlaceholder} />
                    </div>
                </div>
            </div>
        </div>`;
}

const SPONSORS = [
    {
        key: 'packycode',
        logo: 'static/packycode.png',
        href: 'https://www.packyapi.com/register?aff=AIClient2API',
        alt: 'PackyCode Sponsor',
        descKey: 'sponsors.packyDesc'
    },
    {
        key: 'vmcard',
        logo: 'static/vmcard.png',
        href: 'https://vmcardio.com/zh/register?code=902506',
        alt: 'VMCard Sponsor',
        descKey: 'sponsors.vmcardDesc'
    }
];

export function DashboardSponsors() {
    return html`
        <section id="sponsors" class="dashboard-sponsors" aria-labelledby="sponsors-title">
            <h2 id="sponsors-title">${t('sponsors.title')}</h2>
            <p class="sponsors-subtitle">${t('sponsors.subtitle')}</p>

            <div class="sponsors-container">
                ${SPONSORS.map((sponsor) => html`
                    <div class="sponsor-card" key=${sponsor.key}>
                        <div class="sponsor-logo">
                            <a href=${sponsor.href} target="_blank" rel="noopener noreferrer">
                                <img src=${sponsor.logo} alt=${sponsor.alt} />
                            </a>
                        </div>
                        <div class="sponsor-content">
                            <p dangerouslySetInnerHTML=${{ __html: t(sponsor.descKey) }}></p>
                        </div>
                    </div>`)}
            </div>
        </section>`;
}
