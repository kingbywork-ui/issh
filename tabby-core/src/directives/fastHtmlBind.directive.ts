import { Directive, Input, ElementRef, OnChanges } from '@angular/core'
import DOMPurify from 'dompurify'
import { PlatformService } from '../api/platform'

const EXTERNAL_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])
const FORBIDDEN_HTML_TAGS = ['base', 'embed', 'form', 'iframe', 'input', 'link', 'meta', 'object', 'script', 'style']

/** @hidden */
@Directive({
    selector: '[fastHtmlBind]',
})
export class FastHtmlBindDirective implements OnChanges {
    @Input() fastHtmlBind?: string
    private _lastValue?: string

    constructor (
        private el: ElementRef,
        private platform: PlatformService,
    ) { }

    ngOnChanges (): void {
        if (this.fastHtmlBind === this._lastValue) {
            return
        }
        this._lastValue = this.fastHtmlBind
        const sanitized = DOMPurify.sanitize(this.fastHtmlBind ?? '', {
            USE_PROFILES: { html: true, svg: true, svgFilters: true },
            FORBID_TAGS: FORBIDDEN_HTML_TAGS,
            FORBID_ATTR: ['srcdoc', 'style'],
            ALLOW_UNKNOWN_PROTOCOLS: false,
        })
        this.el.nativeElement.innerHTML = sanitized
        const links = Array.from(this.el.nativeElement.querySelectorAll('a')) as HTMLAnchorElement[]
        for (const link of links) {
            link.rel = 'noopener noreferrer'
            link.addEventListener('click', event => {
                event.preventDefault()
                try {
                    const target = new URL(link.href)
                    if (EXTERNAL_LINK_PROTOCOLS.has(target.protocol)) {
                        this.platform.openExternal(target.toString())
                    }
                } catch {
                    // Ignore malformed and non-external links.
                }
            })
        }
    }
}
