/** 使用指南页面（Phase 2 迁移，纯展示）。 */
import { html } from '../html.js';
import { t } from '../lib/i18n.js';

const FAQ_ITEMS = ['1', '2', '3', '5', '6', '7', '8', '9'];

export default function GuideSection() {
    return html`
        <section id="guide" class="section active" aria-labelledby="guide-title">
            <h2 id="guide-title">${t('guide.title')}</h2>

            <div class="guide-panel">
                <h3><i class="fas fa-info-circle"></i> <span>${t('guide.intro.title')}</span></h3>
                <div class="guide-content">
                    <p>${t('guide.intro.desc')}</p>
                    <p class="guide-docs-link">
                        <i class="fas fa-book-open"></i>
                        <span>${t('guide.docsHint')}</span>
                        <a href="https://github.com/GreyRaphael/AIClient2API#readme" target="_blank"
                            rel="noopener noreferrer">${t('guide.docsLink')}</a>
                    </p>
                </div>
            </div>

            <div class="guide-panel">
                <h3><i class="fas fa-question-circle"></i> <span>${t('guide.faq.title')}</span></h3>
                <div class="guide-content">
                    <div class="faq-list">
                        ${FAQ_ITEMS.map((index) => html`
                            <div class="faq-item" key=${index}>
                                <div class="faq-question">${t(`guide.faq.q${index}`)}</div>
                                <div class="faq-answer">${t(`guide.faq.a${index}`)}</div>
                            </div>`)}
                    </div>
                </div>
            </div>
        </section>`;
}
