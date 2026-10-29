/** 仪表盘联系方式与赞助商（Phase 3 迁移，图片随语言切换）。 */
import { html } from '../../html.js';
import { t, lang } from '../../lib/i18n.js';

export function DashboardContact() {
    const isEnglish = lang.value === 'en-US';

    const contact = isEnglish
        ? {
            image: 'static/x.com.png',
            alt: 'X.com',
            icon: 'fab fa-x-twitter',
            title: t('dashboard.contact.x'),
            desc: t('dashboard.contact.xDesc')
        }
        : {
            image: 'static/wechat.png',
            alt: t('dashboard.contact.wechatAlt'),
            icon: 'fab fa-weixin',
            title: t('dashboard.contact.wechat'),
            desc: t('dashboard.contact.wechatDesc')
        };

    const support = isEnglish
        ? {
            image: 'static/coffee.png',
            alt: 'Buy me a coffee',
            title: t('dashboard.contact.coffee'),
            desc: t('dashboard.contact.coffeeDesc')
        }
        : {
            image: 'static/sponsor.png',
            alt: t('dashboard.contact.sponsorAlt'),
            title: t('dashboard.contact.sponsor'),
            desc: t('dashboard.contact.sponsorDesc')
        };

    return html`
        <div class="contact-section dashboard-contact">
            <div class="contact-grid">
                <div class="contact-card">
                    <h3><i class=${contact.icon}></i> <span>${contact.title}</span></h3>
                    <div class="qr-container">
                        <img src=${contact.image} alt=${contact.alt} class="qr-code clickable-qr" />
                    </div>
                    <p class="qr-description">${contact.desc}</p>
                </div>
                <div class="contact-card" id="sponsor-card">
                    <h3><i class="fas fa-heart"></i> <span>${support.title}</span></h3>
                    <div class="qr-container">
                        <img src=${support.image} alt=${support.alt} class="qr-code clickable-qr" />
                    </div>
                    <p class="qr-description">${support.desc}</p>
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

                <div class="sponsor-card become-sponsor">
                    <div class="sponsor-logo">
                        <i class="fas fa-handshake"></i>
                    </div>
                    <div class="sponsor-content">
                        <h3><strong>${t('sponsors.becomeTitle')}</strong></h3>
                        <p>${t('sponsors.becomeDesc')}</p>
                    </div>
                </div>
            </div>
        </section>`;
}
