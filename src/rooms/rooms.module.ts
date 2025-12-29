import { Module } from '@nestjs/common';
import { RoomsService } from './rooms.service';
import { RoomsGateway } from './rooms.gateway';

@Module({
  providers: [RoomsService, RoomsGateway]
})
export class RoomsModule {}
