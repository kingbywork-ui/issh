/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Component, Input, HostBinding, ElementRef, Output, EventEmitter } from '@angular/core'
import { SelfPositioningComponent } from './selfPositioning.component'
import { SplitContainer } from './splitTab.component'

/** @hidden */
@Component({
    standalone: false,
    selector: 'split-tab-spanner',
    template: '',
    styleUrls: ['./splitTabSpanner.component.scss'],
})
export class SplitTabSpannerComponent extends SelfPositioningComponent {
    @Input() container: SplitContainer
    @Input() index: number
    @Output() resizing = new EventEmitter<boolean>()
    @Output() change = new EventEmitter<void>()
    @HostBinding('class.active') isActive = false
    @HostBinding('class.h') isHorizontal = false
    @HostBinding('class.v') isVertical = true
    private marginOffset = -5
    private stopResize: (() => void)|null = null

    // eslint-disable-next-line @typescript-eslint/no-useless-constructor
    constructor (element: ElementRef) {
        super(element)
    }

    ngAfterViewInit () {
        this.element.nativeElement.addEventListener('dblclick', () => {
            this.reset()
        })

        this.element.nativeElement.addEventListener('mousedown', (e: MouseEvent) => {
            if (e.button !== 0) {
                return
            }
            const parent = this.element.nativeElement.parentElement as HTMLElement|null
            if (!parent) {
                return
            }
            e.preventDefault()
            this.stopResize?.()
            this.isActive = true
            this.resizing.emit(true)
            const start = this.isVertical ? e.pageY : e.pageX
            let current = start
            const oldPosition: number = this.isVertical ? this.element.nativeElement.offsetTop : this.element.nativeElement.offsetLeft

            const dragHandler = (dragEvent: MouseEvent) => {
                current = this.isVertical ? dragEvent.pageY : dragEvent.pageX
                const newPosition = oldPosition + (current - start)
                if (this.isVertical) {
                    this.element.nativeElement.style.top = `${newPosition - this.marginOffset}px`
                } else {
                    this.element.nativeElement.style.left = `${newPosition - this.marginOffset}px`
                }
            }

            const offHandler = () => {
                this.isActive = false
                this.resizing.emit(false)
                this.stopResize?.()

                let diff = (current - start) / (this.isVertical ? parent.clientHeight : parent.clientWidth)

                diff = Math.max(diff, -this.container.ratios[this.index - 1] + 0.1)
                diff = Math.min(diff, this.container.ratios[this.index] - 0.1)

                if (diff) {
                    this.container.ratios[this.index - 1] += diff
                    this.container.ratios[this.index] -= diff
                    this.change.emit()
                }
            }

            this.stopResize = () => {
                document.removeEventListener('mousemove', dragHandler)
                document.removeEventListener('mouseup', offHandler)
                window.removeEventListener('blur', offHandler)
                this.stopResize = null
            }
            document.addEventListener('mousemove', dragHandler)
            document.addEventListener('mouseup', offHandler)
            window.addEventListener('blur', offHandler)
        })
    }

    override ngOnDestroy (): void {
        if (this.isActive) {
            this.isActive = false
            this.resizing.emit(false)
        }
        this.stopResize?.()
        super.ngOnDestroy()
    }

    ngOnChanges () {
        this.isHorizontal = this.container.orientation === 'h'
        this.isVertical = this.container.orientation === 'v'
        if (this.isVertical) {
            this.setDimensions(
                this.container.x,
                this.container.y + this.container.h * this.container.getOffsetRatio(this.index),
                this.container.w,
                0,
            )
        } else {
            this.setDimensions(
                this.container.x + this.container.w * this.container.getOffsetRatio(this.index),
                this.container.y,
                0,
                this.container.h,
            )
        }
    }

    reset () {
        const ratio = (this.container.ratios[this.index - 1] + this.container.ratios[this.index]) / 2
        this.container.ratios[this.index - 1] = ratio
        this.container.ratios[this.index] = ratio
        this.change.emit()
    }
}
